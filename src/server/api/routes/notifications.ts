import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification
} from '../../persistence/notification-store';

const router = Router();
router.use(requireAuth);

/** GET /api/notifications — list notifications for current user */
router.get('/', async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = parseInt(req.query.offset as string) || 0;
  const notifications = await getUserNotifications(userId, limit, offset);
  res.json(notifications);
});

/** PATCH /api/notifications/read-all — mark all as read */
router.patch('/read-all', async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  await markAllNotificationsAsRead(userId);
  res.json({ ok: true });
});

/** PATCH /api/notifications/:id/read — mark specific notification as read */
router.patch('/:id/read', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  await markNotificationAsRead(req.params.id, userId);
  res.json({ ok: true });
});

/** DELETE /api/notifications/:id — delete a notification */
router.delete('/:id', async (req, res) => {
  const { userId } = req as any as AuthenticatedRequest;
  await deleteNotification(req.params.id, userId);
  res.json({ ok: true });
});

export default router;
