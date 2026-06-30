import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { CreateDocumentSchema } from '../../security/input-sanitizer';
import {
  createDocument,
  listDocuments,
  getDocumentWithPermission,
  softDeleteDocument,
} from '../../persistence/document-store';
import { query } from '../../persistence/db';
import { createNotification } from '../../persistence/notification-store';
import { publishUserNotification } from '../../fanout/redis-pubsub';

const router = Router();
router.use(requireAuth);

/** POST /api/docs — create a new document */
router.post('/', validate(CreateDocumentSchema), async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const doc = await createDocument(req.body.title, userId);
  res.status(201).json(doc);
});

/** GET /api/docs — list documents accessible to the current user */
router.get('/', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const docs = await listDocuments(userId);
  res.json(docs);
});

/** GET /api/docs/:id — get document metadata */
router.get('/:id', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  if (!doc) {
    res.status(404).json({ error: 'Document not found or access denied' });
    return;
  }
  res.json(doc);
});

/** DELETE /api/docs/:id — soft-delete a document */
router.delete('/:id', async (req, res) => {
  const { userId } = req as any;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.role !== 'owner') {
    res.status(403).json({ error: 'Only the owner can delete a document' });
    return;
  }
  await softDeleteDocument(req.params.id, userId);
  res.json({ ok: true });
});

/** POST /api/docs/:id/invites — invite a user to a document */
router.post('/:id/invites', async (req, res) => {
  const { userId, userEmail: currentUserEmail } = req as any as AuthenticatedRequest;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.role !== 'owner' && doc.role !== 'editor') {
    res.status(403).json({ error: 'You do not have permission to invite users' });
    return;
  }

  const { email, role = 'viewer', type = 'email' } = req.body;

  if (type !== 'email') {
    res.status(400).json({ error: 'Only email invitations are supported in this version' });
    return;
  }

  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  // 1. Validate email is registered
  const { query } = await import('../../persistence/db');
  const userRows = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = $1`,
    [email]
  );

  if (userRows.length === 0) {
    res.status(404).json({ error: 'No registered user found with that email address' });
    return;
  }

  const targetUserId = userRows[0].id;

  // 2. Validate user is not self
  if (targetUserId === userId) {
    res.status(400).json({ error: 'You cannot invite yourself' });
    return;
  }

  // 3. Validate not already a collaborator
  const collabRows = await query<{ role: string }>(
    `SELECT role FROM document_permissions WHERE doc_id = $1 AND user_id = $2`,
    [req.params.id, targetUserId]
  );
  if (collabRows.length > 0) {
    res.status(400).json({ error: 'User is already a collaborator on this document' });
    return;
  }

  // 4. Validate max 10 collaborators
  const totalCollabRows = await query<{ count: string }>(
    `SELECT COUNT(*) FROM document_permissions WHERE doc_id = $1`,
    [req.params.id]
  );
  if (parseInt(totalCollabRows[0].count, 10) >= 10) {
    res.status(400).json({ error: 'Maximum collaborator limit (10) reached for this document' });
    return;
  }

  // 5. Check if invitation already exists
  const pendingInviteRows = await query<{ id: string }>(
    `SELECT id FROM invitations WHERE doc_id = $1 AND invitee_email = $2 AND expires_at > NOW() AND status = 'pending'`,
    [req.params.id, email]
  );
  if (pendingInviteRows.length > 0) {
    res.status(400).json({ error: 'An invitation is already pending for this user' });
    return;
  }

  // 6. Create invitation record
  const { createEmailInvitation } = await import('../../persistence/invitation-store');
  const invite = await createEmailInvitation(req.params.id, userId, email, role);

  // 7. Create notification in database
  const notification = await createNotification(
    targetUserId,
    'INVITATION',
    'Document Invitation',
    `${currentUserEmail} invited you to edit "${doc.title}"`,
    `/invite/${invite.token}`
  );

  // 8. Publish real-time notification
  const { publishUserNotification } = await import('../../fanout/redis-pubsub');
  await publishUserNotification(targetUserId, notification);

  // Log activity
  await query(
    `INSERT INTO audit_log (doc_id, user_id, action, metadata) VALUES ($1, $2, 'invite_user', $3::jsonb)`,
    [req.params.id, userId, JSON.stringify({ invited_email: email, role })]
  );

  res.status(201).json(invite);
});

/** GET /api/docs/:id/invites — list pending invitations for a document */
router.get('/:id/invites', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const pendingInvites = await query(
    `SELECT id, invitee_email, role, expires_at FROM invitations WHERE doc_id = $1 AND status = 'pending' AND expires_at > NOW()`,
    [req.params.id]
  );
  res.json(pendingInvites);
});

/** GET /api/docs/:id/collaborators — list document collaborators */
router.get('/:id/collaborators', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const { getCollaborators } = await import('../../persistence/document-store');
  const collaborators = await getCollaborators(req.params.id);
  res.json(collaborators);
});

/** PATCH /api/docs/:id/collaborators/:userId — update collaborator role */
router.patch('/:id/collaborators/:targetUserId', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  
  if (!doc || doc.role !== 'owner') {
    res.status(403).json({ error: 'Only the owner can update roles' });
    return;
  }

  const { role } = req.body;
  const { updateCollaboratorRole } = await import('../../persistence/document-store');
  await updateCollaboratorRole(req.params.id, req.params.targetUserId, role);
  res.json({ ok: true });
});

/** DELETE /api/docs/:id/collaborators/:userId — remove a collaborator */
router.delete('/:id/collaborators/:targetUserId', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  const doc = await getDocumentWithPermission(req.params.id, userId);
  
  if (!doc || (doc.role !== 'owner' && userId !== req.params.targetUserId)) {
    res.status(403).json({ error: 'Not authorized to remove this collaborator' });
    return;
  }

  const { removeCollaborator } = await import('../../persistence/document-store');
  await removeCollaborator(req.params.id, req.params.targetUserId);
  res.json({ ok: true });
});

export default router;
