/**
 * Offline merger — handles reconnecting clients.
 *
 * When a client reconnects with lastSeq > 0, it has:
 *   - A local CRDT state that diverged from the server during disconnection
 *   - A buffer of locally applied operations not yet sent to the server
 *
 * This module computes:
 *   1. `missedOps`: operations the client missed (server seq > client's lastSeq)
 *      → these are sent in JOIN_ACK so the client can merge them into its local CRDT
 *
 * The client is responsible for:
 *   1. Applying missedOps to its local CRDT (merge is commutative — order doesn't matter)
 *   2. Re-sending its buffered local ops (they'll be applied normally by the server)
 *
 * CRDT property that makes this work: because RGA is commutative and idempotent,
 * the client's local ops + server's missed ops can be applied in ANY order and
 * produce the same final state. No "transform" step is required.
 */

import { loadOperationsAfterSeq } from '../persistence/operation-store';
import type { OperationEnvelope } from '../../shared/types/operation';
import { logger } from '../logger';

/**
 * Computes the list of operations a client missed during disconnection.
 *
 * @param docId - Document ID
 * @param lastSeq - Last server seq the client received (from their JOIN message)
 * @param limit - Max operations to return (prevents huge payloads for very long disconnections)
 */
export async function getMissedOperations(
  docId: string,
  lastSeq: number,
  limit = 5000,
): Promise<OperationEnvelope[]> {
  if (lastSeq === 0) return []; // Fresh join — client gets the full snapshot

  const ops = await loadOperationsAfterSeq(docId, lastSeq, limit);

  logger.info(
    { docId, lastSeq, missedCount: ops.length },
    'Computed missed operations for reconnecting client',
  );

  return ops;
}

/**
 * Determines if a reconnecting client's missed operations are too numerous
 * to send incrementally (should receive a full snapshot reload instead).
 */
export function shouldForceFullReload(missedOps: OperationEnvelope[]): boolean {
  const MAX_INCREMENTAL_OPS = 5000;
  const MAX_TOTAL_PAYLOAD_CHARS = 500_000;

  if (missedOps.length > MAX_INCREMENTAL_OPS) return true;

  const totalChars = missedOps.reduce((sum, env) => {
    if (env.op.type === 'INSERT') return sum + (env.op.value?.length ?? 0);
    return sum;
  }, 0);

  return totalChars > MAX_TOTAL_PAYLOAD_CHARS;
}
