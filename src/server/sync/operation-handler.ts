/**
 * Operation handler — the central coordinator for processing client operations.
 *
 * Processing pipeline for each incoming OPERATION message:
 *
 *   1. Validate the operation structure (Zod schema)
 *   2. Check rate limit (Redis sliding window)
 *   3. Check replay (Redis SETNX nonce)
 *   4. Verify the siteId matches the session's assigned siteId (impersonation prevention)
 *   5. Load (or cache-hit) the RGADocument
 *   6. Apply operation to the in-memory CRDT replica
 *   7. Persist to PostgreSQL operations table (append-only)
 *   8. Update document cache with new seq
 *   9. Publish to Redis channel (fan-out to all workers)
 *  10. Send OP_ACK to the originating client
 *  11. Trigger snapshot compaction if threshold reached
 */

import { v4 as uuidv4 } from 'uuid';
import type { ClientSession } from '../transport/session-manager';
import type { ValidatedOperationMessage } from '../security/input-sanitizer';
import { getOrLoadDocument, updateCachedDocument } from './document-cache';
import { appendOperation } from '../persistence/operation-store';
import { publishOperation } from '../fanout/redis-pubsub';
import { isReplay } from '../security/replay-guard';
import { checkRateLimit } from './rate-limiter';
import { maybeTakeSnapshot } from '../jobs/snapshot-compactor';
import type { OperationEnvelope } from '../../shared/types/operation';
import { logger } from '../logger';

export interface OperationResult {
  success: boolean;
  envelope?: OperationEnvelope;
  error?: { code: string; message: string };
}

/**
 * Processes a validated OPERATION message from a client.
 */
export async function handleOperation(
  session: ClientSession,
  msg: ValidatedOperationMessage,
): Promise<OperationResult> {
  // ── 1. Rate limit ──────────────────────────────────────────────────────────
  const rateResult = await checkRateLimit(session.userId);
  if (!rateResult.allowed) {
    return {
      success: false,
      error: { code: 'RATE_LIMITED', message: `Rate limit exceeded. Retry after ${rateResult.retryAfterMs}ms` },
    };
  }

  // ── 2. Replay check ────────────────────────────────────────────────────────
  const replay = await isReplay(msg.docId, msg.nonce);
  if (replay) {
    return { success: false, error: { code: 'REPLAY_DETECTED', message: 'Duplicate operation' } };
  }

  // ── 3. SiteId validation ───────────────────────────────────────────────────
  if (msg.op.type === 'INSERT' && msg.op.uid.siteId !== session.siteId) {
    return {
      success: false,
      error: {
        code: 'INVALID_OPERATION',
        message: `UID siteId mismatch: expected ${session.siteId}, got ${msg.op.uid.siteId}`,
      },
    };
  }

  // ── 4. Load document cache ─────────────────────────────────────────────────
  const cached = await getOrLoadDocument(msg.docId);

  // ── 5. Apply to in-memory CRDT ─────────────────────────────────────────────
  const applied = cached.doc.applyOperation(msg.op);
  if (!applied && msg.op.type === 'DELETE') {
    // Tombstone not found yet — it might arrive from a concurrent insert.
    // Store the op anyway (for other replicas to use) but log the warning.
    logger.warn({ docId: msg.docId, op: msg.op }, 'Delete applied before insert (causal gap)');
  }

  // ── 6. Persist to PostgreSQL ───────────────────────────────────────────────
  const envelope = await appendOperation({
    docId: msg.docId,
    sessionId: session.id,
    userId: session.userId,
    clientSeq: msg.clientSeq,
    op: msg.op,
    vectorClock: msg.vectorClock,
    nonce: msg.nonce,
  });

  // ── 7. Update cache ────────────────────────────────────────────────────────
  updateCachedDocument(msg.docId, (entry) => {
    entry.lastSeq = envelope.seq;
    entry.opsSinceSnapshot++;
  });

  // ── 8. Publish to Redis (triggers broadcast on all workers) ───────────────
  await publishOperation(envelope);

  // ── 9. Maybe snapshot ─────────────────────────────────────────────────────
  maybeTakeSnapshot(msg.docId).catch((err) =>
    logger.error({ err, docId: msg.docId }, 'Background snapshot failed'),
  );

  logger.debug({ docId: msg.docId, seq: envelope.seq, userId: session.userId }, 'Operation processed');
  return { success: true, envelope };
}
