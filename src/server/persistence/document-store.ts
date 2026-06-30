/**
 * Document CRUD store.
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from './db';
import type { Document, DocumentWithPermission, DocumentPermission } from '../../shared/types/document';
import { logger } from '../logger';

interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: Date;
  updated_at: Date;
  is_deleted: boolean;
  role?: string;
}

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    isDeleted: row.is_deleted,
  };
}

export async function createDocument(
  title: string,
  ownerId: string,
): Promise<Document> {
  const id = uuidv4();
  return withTransaction(async (client) => {
    const [docRow] = await client.query<DocumentRow>(
      `INSERT INTO documents (id, title, owner_id) VALUES ($1, $2, $3) RETURNING *`,
      [id, title, ownerId],
    ).then(r => r.rows);

    await client.query(
      `INSERT INTO document_permissions (doc_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, ownerId],
    );

    await client.query(
      `INSERT INTO audit_log (doc_id, user_id, action, metadata) VALUES ($1, $2, 'create', $3::jsonb)`,
      [id, ownerId, JSON.stringify({ title })],
    );

    logger.info({ docId: id, ownerId }, 'Document created');
    return rowToDocument(docRow);
  });
}

export async function getDocument(docId: string): Promise<Document | null> {
  const rows = await query<DocumentRow>(
    `SELECT * FROM documents WHERE id = $1 AND is_deleted = false`,
    [docId],
  );
  return rows[0] ? rowToDocument(rows[0]) : null;
}

export async function getDocumentWithPermission(
  docId: string,
  userId: string,
): Promise<DocumentWithPermission | null> {
  const rows = await query<DocumentRow & { role: string }>(
    `SELECT d.*, dp.role
       FROM documents d
       JOIN document_permissions dp ON dp.doc_id = d.id AND dp.user_id = $2
      WHERE d.id = $1 AND d.is_deleted = false`,
    [docId, userId],
  );
  if (!rows[0]) return null;
  return { ...rowToDocument(rows[0]), role: rows[0].role as DocumentPermission };
}

export async function listDocuments(userId: string): Promise<DocumentWithPermission[]> {
  const rows = await query<DocumentRow & { role: string }>(
    `SELECT d.*, dp.role
       FROM documents d
       JOIN document_permissions dp ON dp.doc_id = d.id AND dp.user_id = $1
      WHERE d.is_deleted = false
      ORDER BY d.updated_at DESC`,
    [userId],
  );
  return rows.map(r => ({ ...rowToDocument(r), role: r.role as DocumentPermission }));
}

export async function updateDocumentTitle(docId: string, title: string): Promise<void> {
  await query(
    `UPDATE documents SET title = $2, updated_at = now() WHERE id = $1`,
    [docId, title],
  );
}

export async function touchDocument(docId: string): Promise<void> {
  await query(
    `UPDATE documents SET updated_at = now() WHERE id = $1`,
    [docId],
  );
}

export async function softDeleteDocument(docId: string, userId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE documents SET is_deleted = true, updated_at = now() WHERE id = $1`,
      [docId],
    );
    await client.query(
      `INSERT INTO audit_log (doc_id, user_id, action) VALUES ($1, $2, 'delete')`,
      [docId, userId],
    );
  });
}

export interface Collaborator {
  user_id: string;
  role: DocumentPermission;
  email?: string;
  display_name?: string;
}

export async function getCollaborators(docId: string): Promise<Collaborator[]> {
  const rows = await query<Collaborator>(
    `SELECT dp.user_id, dp.role, u.email, u.display_name
     FROM document_permissions dp
     JOIN users u ON u.id = dp.user_id
     WHERE dp.doc_id = $1`,
    [docId]
  );
  return rows;
}

export async function updateCollaboratorRole(docId: string, userId: string, role: DocumentPermission): Promise<void> {
  await query(
    `UPDATE document_permissions SET role = $3 WHERE doc_id = $1 AND user_id = $2`,
    [docId, userId, role]
  );
}

export async function removeCollaborator(docId: string, userId: string): Promise<void> {
  await query(
    `DELETE FROM document_permissions WHERE doc_id = $1 AND user_id = $2`,
    [docId, userId]
  );
}
