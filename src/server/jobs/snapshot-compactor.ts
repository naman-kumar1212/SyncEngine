/**
 * Background job: periodic snapshot compaction.
 *
 * Triggers a snapshot when:
 *   a) The number of operations since the last snapshot exceeds SNAPSHOT_OPS_THRESHOLD
 *   b) The time since the last snapshot exceeds SNAPSHOT_INTERVAL_MS
 *
 * Snapshots reduce cold-start time from O(all_ops) to O(snapshot_size + delta_ops).
 * They do NOT delete old operations — the operation log is permanent for history.
 *
 * Tombstone GC is run during snapshot saves to compact the in-memory document,
 * reducing toText() / serialize() scan time for long-lived collaborative documents.
 */

import { saveSnapshot } from '../persistence/snapshot-store';
import { getOrLoadDocument, updateCachedDocument } from '../sync/document-cache';
import { getMaxSeq } from '../persistence/operation-store';
import { query } from '../persistence/db';
import { config } from '../config';
import { logger } from '../logger';

/** Maximum number of snapshots to retain per document (older ones are pruned) */
const MAX_SNAPSHOTS_PER_DOC = 10;

// Track last snapshot time per document
const lastSnapshotTime: Map<string, number> = new Map();

/**
 * Called after every operation. Triggers a snapshot if thresholds are met.
 * Runs async in the background — never blocks the operation pipeline.
 */
export async function maybeTakeSnapshot(docId: string): Promise<void> {
  const cached = await getOrLoadDocument(docId);

  const opsThreshold = config.crdt.snapshotOpsThreshold;
  const timeThreshold = config.crdt.snapshotIntervalMs;
  const lastTime = lastSnapshotTime.get(docId) ?? 0;
  const now = Date.now();

  const shouldSnapshot =
    cached.opsSinceSnapshot >= opsThreshold ||
    (now - lastTime) >= timeThreshold;

  if (!shouldSnapshot) return;

  const seq = await getMaxSeq(docId);
  if (seq <= 0) return;

  let gcRemoved = 0;
  try {
    // Run tombstone GC before saving — reduces serialized snapshot size and
    // improves toText() / serialize() scan times for long-lived documents.
    gcRemoved = cached.doc.gc();
    if (gcRemoved > 0) {
      logger.info({ docId, gcRemoved }, 'Tombstone GC ran before snapshot');
    }

    await saveSnapshot(docId, cached.doc, seq);
    lastSnapshotTime.set(docId, now);
    updateCachedDocument(docId, (entry) => {
      entry.opsSinceSnapshot = 0;
    });
    logger.info({ docId, seq, gcRemoved }, 'Snapshot taken by compactor');

    // Prune old snapshots asynchronously (non-critical)
    pruneOldSnapshots(docId).catch((err) =>
      logger.warn({ err, docId }, 'Old snapshot pruning failed (non-critical)'),
    );
  } catch (err) {
    logger.error({ err, docId }, 'Snapshot compaction failed');
  }
}

/**
 * Forces a snapshot for a document (e.g., after a rollback).
 */
export async function forceSnapshot(docId: string): Promise<void> {
  const cached = await getOrLoadDocument(docId);
  const seq = await getMaxSeq(docId);
  if (seq <= 0) return;

  cached.doc.gc(); // Run GC before forced snapshot too
  await saveSnapshot(docId, cached.doc, seq);
  lastSnapshotTime.set(docId, Date.now());
  updateCachedDocument(docId, (entry) => {
    entry.opsSinceSnapshot = 0;
  });
}

/**
 * Prunes old snapshots for a document, keeping only the most recent N.
 * Prevents the snapshots table from growing unboundedly over time.
 */
async function pruneOldSnapshots(docId: string): Promise<void> {
  const deleted = await query<{ id: string }>(
    `DELETE FROM snapshots
      WHERE doc_id = $1
        AND id NOT IN (
          SELECT id FROM snapshots
           WHERE doc_id = $1
           ORDER BY seq DESC
           LIMIT $2
        )
      RETURNING id`,
    [docId, MAX_SNAPSHOTS_PER_DOC],
  );

  if (deleted.length > 0) {
    logger.debug({ docId, pruned: deleted.length }, 'Old snapshots pruned');
  }
}
