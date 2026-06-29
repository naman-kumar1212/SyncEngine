/**
 * Snapshot store — periodic full-state CRDT checkpoints for efficient loading.
 *
 * Document loading strategy:
 *   1. Load latest snapshot (O(1) query)
 *   2. Load operations with seq > snapshot.seq (O(delta))
 *   3. Deserialize snapshot into RGADocument
 *   4. Apply delta operations
 *   Total: O(snapshot_size + delta_ops)  vs  O(all_ops) without snapshots
 */

import { createHash } from 'crypto';
import { query } from './db';
import { RGADocument } from '../../crdt/rga-document';
import type { SerializedRGANode, SnapshotRecord } from '../../shared/types/document';
import { logger } from '../logger';

interface SnapshotRow {
  id: string;
  doc_id: string;
  seq: string;
  data: SerializedRGANode[];
  text_hash: string;
  node_count: number;
  char_count: number;
  created_at: Date;
}

function rowToRecord(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    docId: row.doc_id,
    seq: parseInt(row.seq, 10),
    data: row.data,
    textHash: row.text_hash,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Saves a snapshot of the current RGADocument state for a given seq.
 */
export async function saveSnapshot(
  docId: string,
  doc: RGADocument,
  seq: number,
): Promise<SnapshotRecord> {
  const nodes = doc.serialize();
  const text = doc.toText();
  const textHash = createHash('sha256').update(text).digest('hex');

  const rows = await query<SnapshotRow>(
    `INSERT INTO snapshots (doc_id, seq, data, text_hash, node_count, char_count)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (doc_id, seq) DO NOTHING
     RETURNING *`,
    [docId, seq, JSON.stringify(nodes), textHash, nodes.length, text.length],
  );

  // ON CONFLICT DO NOTHING returns no rows — fetch the existing snapshot instead
  if (rows.length === 0) {
    const existing = await loadLatestSnapshot(docId);
    if (existing && existing.seq === seq) {
      logger.debug({ docId, seq }, 'Snapshot already exists, returning existing record');
      return existing;
    }
    throw new Error(`saveSnapshot: conflict on (${docId}, ${seq}) but could not reload existing`);
  }

  const record = rowToRecord(rows[0]);
  logger.info({ docId, seq, nodes: nodes.length, chars: text.length }, 'Snapshot saved');
  return record;
}

/**
 * Loads the most recent snapshot for a document.
 * Returns null if no snapshot exists (fresh document).
 */
export async function loadLatestSnapshot(docId: string): Promise<SnapshotRecord | null> {
  const rows = await query<SnapshotRow>(
    `SELECT * FROM snapshots
      WHERE doc_id = $1
      ORDER BY seq DESC
      LIMIT 1`,
    [docId],
  );
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

/**
 * Loads the latest snapshot with seq <= targetSeq.
 * Used for rollback: find the best starting checkpoint for a target revision.
 */
export async function loadSnapshotBefore(
  docId: string,
  targetSeq: number,
): Promise<SnapshotRecord | null> {
  const rows = await query<SnapshotRow>(
    `SELECT * FROM snapshots
      WHERE doc_id = $1 AND seq <= $2
      ORDER BY seq DESC
      LIMIT 1`,
    [docId, targetSeq],
  );
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

/**
 * Lists all available snapshots for a document (for the history API).
 */
export async function listSnapshots(docId: string): Promise<SnapshotRecord[]> {
  const rows = await query<SnapshotRow>(
    `SELECT id, doc_id, seq, text_hash, node_count, char_count, created_at
       FROM snapshots
      WHERE doc_id = $1
      ORDER BY seq DESC`,
    [docId],
  );
  return rows.map(r => ({ ...rowToRecord(r), data: [] })); // data omitted for listing
}

/**
 * Verifies the integrity of a snapshot by recomputing the text hash.
 * Returns true if the snapshot is intact.
 */
export async function verifySnapshot(snapshot: SnapshotRecord): Promise<boolean> {
  const doc = RGADocument.deserialize(snapshot.data);
  const text = doc.toText();
  const hash = createHash('sha256').update(text).digest('hex');
  const valid = hash === snapshot.textHash;
  if (!valid) {
    logger.error({ snapshotId: snapshot.id, expected: snapshot.textHash, got: hash },
      'Snapshot integrity check FAILED');
  }
  return valid;
}
