/**
 * History service — query, diff, and restore document revisions.
 *
 * Rollback algorithm:
 *   1. Find snapshot with seq <= targetSeq
 *   2. Replay ops from snapshot.seq+1 to targetSeq
 *   3. Serialize the resulting RGA state
 *   4. Insert a ROLLBACK op at seq N+1 (making rollback itself an event)
 *   5. Save a new snapshot at the rollback seq
 *   6. Broadcast the new state to all connected clients
 */

import { createHash } from 'crypto';
import { query, withTransaction } from './db';
import { RGADocument } from '../../crdt/rga-document';
import { loadSnapshotBefore, saveSnapshot } from './snapshot-store';
import { loadOperationsInRange, appendOperation, getMaxSeq } from './operation-store';
import type { OperationEnvelope } from '../../shared/types/operation';
import type { HistoryPage, OperationSummary, SnapshotRecord } from '../../shared/types/document';
import { logger } from '../logger';

/**
 * Reconstructs the RGADocument state at a given seq by:
 * 1. Loading the best snapshot at or before targetSeq
 * 2. Replaying all operations from snapshot.seq+1 to targetSeq
 */
export async function reconstructAtSeq(
  docId: string,
  targetSeq: number,
): Promise<{ doc: RGADocument; snapshot: SnapshotRecord | null }> {
  const snapshot = await loadSnapshotBefore(docId, targetSeq);

  let doc: RGADocument;
  let fromSeq: number;

  if (snapshot) {
    doc = RGADocument.deserialize(snapshot.data);
    fromSeq = snapshot.seq + 1;
  } else {
    doc = new RGADocument();
    fromSeq = 1;
  }

  if (fromSeq <= targetSeq) {
    const ops = await loadOperationsInRange(docId, fromSeq, targetSeq);
    for (const env of ops) {
      doc.applyOperation(env.op);
    }
  }

  return { doc, snapshot };
}

/**
 * Restores a document to its state at targetSeq.
 * Creates a new "ROLLBACK" operation at seq N+1 and saves a new snapshot.
 *
 * Returns the new OperationEnvelope (the rollback op) and the restored text.
 */
export async function restoreToRevision(params: {
  docId: string;
  targetSeq: number;
  userId: string;
  sessionId: string;
}): Promise<{ envelope: OperationEnvelope; restoredText: string; newSeq: number }> {
  const { docId, targetSeq, userId, sessionId } = params;

  logger.info({ docId, targetSeq, userId }, 'Restoring document to revision');

  const { doc } = await reconstructAtSeq(docId, targetSeq);
  const restoredText = doc.toText();
  const restoredNodes = doc.serialize();

  // Create a sentinel ROLLBACK op - stored with op_type='ROLLBACK' in the DB.
  // The op_data uses a dedicated sentinel that clients skip during replay.
  // This avoids sending a malformed INSERT with a non-UUID siteId to clients.
  const { v4: uuidv4 } = await import('uuid');
  const rollbackSentinelOp = {
    type: 'ROLLBACK' as const,
    uid: { clock: 0, siteId: '00000000-0000-0000-0000-000000000000' }, // nil UUID sentinel
    after: null as null,
    value: '', // empty — actual state carried in the new snapshot
  } as any; // 'ROLLBACK' is stored via op_type column override; clients filter by type

  return withTransaction(async (client) => {
    const envelope = await appendOperation(
      {
        docId,
        sessionId,
        userId,
        clientSeq: 0,
        op: rollbackSentinelOp,
        vectorClock: {},
        nonce: uuidv4(),
      },
      client,
    );

    // Save new snapshot at the rollback seq
    await saveSnapshot(docId, doc, envelope.seq);

    // Update documents.updated_at
    await client.query(
      `UPDATE documents SET updated_at = now() WHERE id = $1`,
      [docId],
    );

    await client.query(
      `INSERT INTO audit_log (doc_id, user_id, action, metadata)
       VALUES ($1, $2, 'restore', $3::jsonb)`,
      [docId, userId, JSON.stringify({ targetSeq, newSeq: envelope.seq })],
    );

    return { envelope, restoredText, newSeq: envelope.seq };
  });
}

/**
 * Paginated history of operations for a document.
 */
export async function getHistory(
  docId: string,
  page = 0,
  pageSize = 50,
): Promise<HistoryPage> {
  const [rows, countRows] = await Promise.all([
    query<{
      seq: string;
      user_id: string;
      display_name: string;
      op_type: string;
      op_data: any;
      created_at: Date;
    }>(
      `SELECT o.seq, o.user_id, u.display_name, o.op_type, o.op_data, o.created_at
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

  const ops: OperationSummary[] = rows.map((r) => ({
    seq: parseInt(r.seq, 10),
    userId: r.user_id,
    displayName: r.display_name,
    opType: r.op_type as 'INSERT' | 'DELETE',
    preview: buildPreview(r.op_type, r.op_data),
    timestamp: r.created_at.toISOString(),
  }));

  return {
    ops,
    total: parseInt(countRows[0].count, 10),
    from: page * pageSize,
    to: Math.min((page + 1) * pageSize, parseInt(countRows[0].count, 10)),
  };
}

function buildPreview(opType: string, opData: any): string {
  if (opType === 'INSERT') return `Inserted "${opData.value ?? ''}"`;
  if (opType === 'DELETE') return `Deleted character`;
  return opType;
}

/**
 * Creates a named revision tag at the current max seq.
 */
export async function createRevisionTag(params: {
  docId: string;
  userId: string;
  label?: string;
}): Promise<void> {
  const { v4: uuidv4 } = await import('uuid');
  const seq = await getMaxSeq(params.docId);
  await query(
    `INSERT INTO revisions (id, doc_id, seq, label, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv4(), params.docId, seq, params.label ?? null, params.userId],
  );
}

/**
 * Lists all revision tags for a document.
 */
export async function listRevisions(docId: string) {
  return query<{
    id: string; seq: number; label: string | null;
    created_by: string; display_name: string; created_at: Date;
  }>(
    `SELECT r.id, r.seq, r.label, r.created_by, u.display_name, r.created_at
       FROM revisions r
       JOIN users u ON u.id = r.created_by
      WHERE r.doc_id = $1
      ORDER BY r.seq DESC`,
    [docId],
  );
}
