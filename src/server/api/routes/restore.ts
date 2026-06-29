import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { RestoreRevisionSchema } from '../../security/input-sanitizer';
import { getDocumentWithPermission } from '../../persistence/document-store';
import { restoreToRevision } from '../../persistence/history-service';
import { invalidateDocument } from '../../sync/document-cache';
import { publishOperation } from '../../fanout/redis-pubsub';
import { v4 as uuidv4 } from 'uuid';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/**
 * POST /api/docs/:id/restore
 * Body: { targetSeq: number, label?: string }
 *
 * Restores the document to its state at targetSeq by:
 *   1. Replaying the operation log up to targetSeq
 *   2. Inserting a ROLLBACK operation at seq N+1
 *   3. Saving a new snapshot
 *   4. Broadcasting the rollback to all connected clients
 *   5. Invalidating the document cache (clients will reload)
 */
router.post('/', validate(RestoreRevisionSchema), async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  const docId = req.params.id;

  const doc = await getDocumentWithPermission(docId, userId);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.role === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot restore revisions' });
    return;
  }

  const { targetSeq, label } = req.body as { targetSeq: number; label?: string };

  const { envelope, restoredText, newSeq } = await restoreToRevision({
    docId,
    targetSeq,
    userId,
    sessionId: uuidv4(),
  });

  // Invalidate cache — all workers will reload from the new snapshot
  invalidateDocument(docId);

  // Broadcast the rollback event to connected clients
  await publishOperation(envelope);

  res.json({
    ok: true,
    newSeq,
    targetSeq,
    textLength: restoredText.length,
    preview: restoredText.slice(0, 200),
  });
});

export default router;
