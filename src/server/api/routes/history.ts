import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.middleware';
import { getDocumentWithPermission } from '../../persistence/document-store';
import { getHistory, listRevisions } from '../../persistence/history-service';
import { listSnapshots } from '../../persistence/snapshot-store';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** GET /api/docs/:id/history?page=0&pageSize=50 */
router.get('/', async (req, res) => {
  const { userId } = req as any;
  const { id } = req.params as any;
  const doc = await getDocumentWithPermission(id, userId);
  if (!doc) return void res.status(404).json({ error: 'Not found' });

  const page = Math.max(0, parseInt(req.query.page as string ?? '0', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string ?? '50', 10)));

  const history = await getHistory(id, page, pageSize);
  res.json(history);
});

/** GET /api/docs/:id/revisions — list named revision tags */
router.get('/revisions', async (req, res) => {
  const { userId } = req as any;
  const { id } = req.params as any;
  const doc = await getDocumentWithPermission(id, userId);
  if (!doc) return void res.status(404).json({ error: 'Not found' });

  const revisions = await listRevisions(id);
  res.json(revisions);
});

/** GET /api/docs/:id/snapshots — list available snapshots */
router.get('/snapshots', async (req, res) => {
  const { userId } = req as any;
  const { id } = req.params as any;
  const doc = await getDocumentWithPermission(id, userId);
  if (!doc) return void res.status(404).json({ error: 'Not found' });

  const snapshots = await listSnapshots(id);
  res.json(snapshots);
});

export default router;
