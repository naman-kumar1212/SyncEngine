import { query } from './db';

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  message: string;
  read_at: Date | null;
  metadata: any;
  created_at: Date;
}

export async function createNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  link?: string
): Promise<Notification> {
  const metadata = JSON.stringify({ title, link });
  const rows = await query<Notification>(
    `INSERT INTO notifications (user_id, type, message, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [userId, type, message, metadata]
  );
  return rows[0];
}

export async function getUserNotifications(userId: string, limit: number = 20, offset: number = 0): Promise<Notification[]> {
  const rows = await query<Notification>(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

export async function markNotificationAsRead(id: string, userId: string): Promise<void> {
  await query(
    `UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}

export async function markAllNotificationsAsRead(userId: string): Promise<void> {
  await query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
}

export async function deleteNotification(id: string, userId: string): Promise<void> {
  await query(
    `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}
