/**
 * Operation store — append-only event store for CRDT operations.
 *
 * ALL writes are inserts. No updates. No deletes.
 * This guarantees a complete, replayable history of all edits.
 */

import { PoolClient } from 'pg';
import { query, getPool } from './db';
import type { OperationEnvelope, RGAOperation } from '../../shared/types/operation';
import { logger } from '../logger';

interface OperationRow {
  id: string;
  doc_id: string;
  session_id: string;
  user_id: string;
  seq: string; // PG returns BIGINT as string
  client_seq: string;
  op_type: string;
  op_data: RGAOperation;
  vector_clock: Record<string, number>;
  nonce: string;
  created_at: Date;
}

function rowToEnvelope(row: OperationRow): OperationEnvelope {
  return {
    id: row.id,
    docId: row.doc_id,
    sessionId: row.session_id,
    userId: row.user_id,
    op: row.op_data,
    seq: parseInt(row.seq, 10),
    clientSeq: parseInt(row.client_seq, 10),
    timestamp: row.created_at.toISOString(),
    vectorClock: row.vector_clock,
    nonce: row.nonce,
  };
}

/**
 * Appends a new operation to the event store.
 * Uses the `next_doc_seq` PostgreSQL function to atomically assign a sequence number.
 *
 * @returns The persisted envelope with server-assigned `id`, `seq`, and `timestamp`.
 */
export async function appendOperation(
  params: {
    docId: string;
    sessionId: string;
    userId: string;
    clientSeq: number;
    op: RGAOperation;
    vectorClock: Record<string, number>;
    nonce: string;
  },
  client?: PoolClient,
): Promise<OperationEnvelope> {
  const db = client ?? getPool();

  const result = await db.query<OperationRow>(
    `INSERT INTO operations
       (doc_id, session_id, user_id, seq, client_seq, op_type, op_data, vector_clock, nonce)
     VALUES
       ($1, $2, $3, next_doc_seq($1), $4, $5, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [
      params.docId,
      params.sessionId,
      params.userId,
      params.clientSeq,
      params.op.type,
      JSON.stringify(params.op),
      JSON.stringify(params.vectorClock),
      params.nonce,
    ],
  );

  const envelope = rowToEnvelope(result.rows[0]);
  logger.debug({ docId: params.docId, seq: envelope.seq }, 'Operation appended');
  return envelope;
}

/**
 * Loads all operations for a document with seq > afterSeq, in order.
 * Used for reconnect recovery and document loading.
 */
export async function loadOperationsAfterSeq(
  docId: string,
  afterSeq: number,
  limit = 10_000,
): Promise<OperationEnvelope[]> {
  const rows = await query<OperationRow>(
    `SELECT * FROM operations
      WHERE doc_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [docId, afterSeq, limit],
  );
  return rows.map(rowToEnvelope);
}

/**
 * Loads operations in a seq range [fromSeq, toSeq] inclusive.
 * Used for rollback (replay up to a target seq).
 */
export async function loadOperationsInRange(
  docId: string,
  fromSeq: number,
  toSeq: number,
): Promise<OperationEnvelope[]> {
  const rows = await query<OperationRow>(
    `SELECT * FROM operations
      WHERE doc_id = $1 AND seq >= $2 AND seq <= $3
      ORDER BY seq ASC`,
    [docId, fromSeq, toSeq],
  );
  return rows.map(rowToEnvelope);
}

/**
 * Returns the current maximum seq for a document.
 * Returns 0 if no operations exist.
 */
export async function getMaxSeq(docId: string): Promise<number> {
  const rows = await query<{ max_seq: string | null }>(
    `SELECT MAX(seq) as max_seq FROM operations WHERE doc_id = $1`,
    [docId],
  );
  return parseInt(rows[0]?.max_seq ?? '0', 10);
}

/**
 * Checks if a nonce has already been used (replay-attack detection in DB).
 * The primary check is in Redis; this is the fallback.
 */
export async function nonceExists(nonce: string): Promise<boolean> {
  const rows = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM operations WHERE nonce = $1`,
    [nonce],
  );
  return parseInt(rows[0].count, 10) > 0;
}

/**
 * Paginated operation log for the history API.
 */
export async function queryHistory(
  docId: string,
  page: number,
  pageSize: number,
): Promise<{ ops: OperationEnvelope[]; total: number }> {
  const [rows, countRows] = await Promise.all([
    query<OperationRow>(
      `SELECT o.*, u.display_name
         FROM operations o
         JOIN users u ON u.id = o.user_id
        WHERE o.doc_id = $1
        ORDER BY o.seq DESC
        LIMIT $2 OFFSET $3`,
      [docId, pageSize, page * pageSize],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM operations WHERE doc_id = $1`,
      [docId],
    ),
  ]);

  return {
    ops: rows.map(rowToEnvelope),
    total: parseInt(countRows[0].count, 10),
  };
}
