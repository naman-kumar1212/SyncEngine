import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.middleware';
import { query } from '../../persistence/db';
import type { DocumentWithPermission } from '../../../shared/types/document';
import { listDocuments } from '../../persistence/document-store';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { userId } = req as AuthenticatedRequest;

  try {
    // 1. Get recent documents (already have a function for this)
    const recentDocs = await listDocuments(userId);
    const topRecentDocs = recentDocs.slice(0, 10);

    // 2. Get unread notifications count
    const notifRows = await query<{ count: string }>(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    );
    const unreadNotificationsCount = parseInt(notifRows[0]?.count || '0', 10);

    // 3. Get starred documents
    const starredRows = await query<any>(
      `SELECT d.*, dp.role
         FROM documents d
         JOIN document_permissions dp ON dp.doc_id = d.id AND dp.user_id = $1
         JOIN user_documents_meta udm ON udm.doc_id = d.id AND udm.user_id = $1
        WHERE d.is_deleted = false AND udm.is_starred = true
        ORDER BY d.updated_at DESC
        LIMIT 10`,
      [userId]
    );

    const starredDocs: DocumentWithPermission[] = starredRows.map((r: any) => ({
      id: r.id,
      title: r.title,
      ownerId: r.owner_id,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      isDeleted: r.is_deleted,
      role: r.role
    }));

    res.json({
      recentDocuments: topRecentDocs,
      starredDocuments: starredDocs,
      unreadNotificationsCount
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

export default router;
