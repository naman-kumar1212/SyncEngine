import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.middleware';
import { acceptInvitation, getInvitationByToken, revokeInvitation, rejectInvitation } from '../../persistence/invitation-store';

const router = Router();
router.use(requireAuth);

/** GET /api/invites/:token — get invite metadata */
router.get('/:token', async (req, res) => {
  const invite = await getInvitationByToken(req.params.token);
  if (!invite) {
    res.status(404).json({ error: 'Invitation not found or expired' });
    return;
  }
  res.json({ docId: invite.doc_id, role: invite.role, email: invite.invitee_email });
});

/** POST /api/invites/:token/accept — accept an invite */
router.post('/:token/accept', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  try {
    const docId = await acceptInvitation(req.params.token, userId);
    res.json({ ok: true, docId });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to accept invitation' });
  }
});

/** POST /api/invites/:token/reject — reject an invite */
router.post('/:token/reject', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  try {
    await rejectInvitation(req.params.token, userId);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to reject invitation' });
  }
});

/** DELETE /api/invites/:id — revoke an invite */
router.delete('/:id', async (req, res) => {
  // Requires authorization checks in a real system (ensure the user is owner of the doc).
  // Simplified for now.
  await revokeInvitation(req.params.id);
  res.json({ ok: true });
});

export default router;
