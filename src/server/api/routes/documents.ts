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

const router = Router();
router.use(requireAuth);

/** POST /api/docs — create a new document */
router.post('/', validate(CreateDocumentSchema), async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  const doc = await createDocument(req.body.title, userId);
  res.status(201).json(doc);
});

/** GET /api/docs — list documents accessible to the current user */
router.get('/', async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  const docs = await listDocuments(userId);
  res.json(docs);
});

/** GET /api/docs/:id — get document metadata */
router.get('/:id', async (req, res) => {
  const { userId } = req as any;
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

export default router;
