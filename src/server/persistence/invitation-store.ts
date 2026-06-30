import { query, withTransaction } from './db';
import crypto from 'crypto';
import type { DocumentPermission } from '../../shared/types/document';
import { logger } from '../logger';

export interface Invitation {
  id: string;
  doc_id: string;
  inviter_id: string;
  invitee_email: string | null;
  role: DocumentPermission;
  token: string;
  status: string;
  expires_at: Date;
  created_at: Date;
}

export async function createEmailInvitation(
  docId: string,
  inviterId: string,
  email: string,
  role: DocumentPermission,
  expiresInHours: number = 72
): Promise<Invitation> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + expiresInHours);

  const rows = await query<Invitation>(
    `INSERT INTO invitations (doc_id, inviter_id, invitee_email, role, token, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING *`,
    [docId, inviterId, email, role, token, expiresAt]
  );
  
  logger.info({ docId, email, role }, 'Created email invitation');
  return rows[0];
}

export async function createLinkInvitation(
  docId: string,
  inviterId: string,
  role: DocumentPermission
): Promise<Invitation> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 10); // Effectively never expires, but we set a date

  const rows = await query<Invitation>(
    `INSERT INTO invitations (doc_id, inviter_id, role, token, status, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     RETURNING *`,
    [docId, inviterId, role, token, expiresAt]
  );
  
  logger.info({ docId, role }, 'Created link invitation');
  return rows[0];
}

export async function getInvitationByToken(token: string): Promise<Invitation | null> {
  const rows = await query<Invitation>(
    `SELECT * FROM invitations WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

export async function revokeInvitation(id: string): Promise<void> {
  await query(`DELETE FROM invitations WHERE id = $1`, [id]);
}

export async function acceptInvitation(token: string, userId: string): Promise<string> {
  return withTransaction(async (client) => {
    // 1. Get and validate invite
    const inviteRows = await client.query<Invitation>(
      `SELECT * FROM invitations WHERE token = $1 AND expires_at > NOW()`,
      [token]
    ).then(r => r.rows);
    
    if (inviteRows.length === 0) {
      throw new Error('Invalid or expired invitation token');
    }
    const invite = inviteRows[0];

    // 2. Add permission
    await client.query(
      `INSERT INTO document_permissions (doc_id, user_id, role) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (doc_id, user_id) 
       DO UPDATE SET role = EXCLUDED.role`,
      [invite.doc_id, userId, invite.role]
    );

    // 3. Update invite status (if it was an email invite, it's one-time use)
    if (invite.invitee_email) {
      await client.query(`UPDATE invitations SET status = 'accepted' WHERE id = $1`, [invite.id]);
    }

    // 4. Log
    await client.query(
      `INSERT INTO audit_log (doc_id, user_id, action, metadata) VALUES ($1, $2, 'accept_invite', $3::jsonb)`,
      [invite.doc_id, userId, JSON.stringify({ role: invite.role })]
    );

    return invite.doc_id;
  });
}

export async function rejectInvitation(token: string, userId: string): Promise<void> {
  return withTransaction(async (client) => {
    const inviteRows = await client.query<Invitation>(
      `SELECT * FROM invitations WHERE token = $1 AND expires_at > NOW()`,
      [token]
    ).then(r => r.rows);
    
    if (inviteRows.length === 0) {
      throw new Error('Invalid or expired invitation token');
    }
    const invite = inviteRows[0];

    // Mark invite as rejected (if it was an email invite)
    if (invite.invitee_email) {
      await client.query(`UPDATE invitations SET status = 'rejected' WHERE id = $1`, [invite.id]);
    }

    // Log
    await client.query(
      `INSERT INTO audit_log (doc_id, user_id, action, metadata) VALUES ($1, $2, 'reject_invite', $3::jsonb)`,
      [invite.doc_id, userId, JSON.stringify({ role: invite.role })]
    );
  });
}
