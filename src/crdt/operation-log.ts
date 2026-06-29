/**
 * In-memory ordered operation log with causal buffering.
 *
 * Handles two critical problems:
 *   1. Out-of-order delivery: If operation B arrives before A (where A causally
 *      precedes B), B is held in a buffer until A arrives.
 *   2. Duplicate delivery: Operations with known UIDs are discarded.
 *
 * The buffer uses a simple O(n) retry on each new operation, which is
 * acceptable because causal gaps are rare in practice.
 */

import type { RGAOperation, OperationEnvelope } from '../shared/types/operation';
import { uidKey } from '../shared/types/operation';
import { RGADocument } from './rga-document';

export interface PendingOp {
  envelope: OperationEnvelope;
  attempts: number;
  firstSeen: number; // Unix ms
}

export class OperationLog {
  /** Applied operations indexed by server seq */
  private appliedSeqs: Set<number> = new Set();
  /** Applied operations indexed by (docId, clientSeq, sessionId) */
  private appliedClientKeys: Set<string> = new Set();
  /** Operations waiting for causal predecessors */
  private buffer: PendingOp[] = [];
  private readonly maxBufferSize: number;
  /** Tracked max applied seq to avoid O(n) Math.max spread */
  private _maxAppliedSeq = 0;
  /**
   * Optional callback fired when the causal buffer overflows and we cannot
   * safely apply ops in order. The callback should trigger a full state reload
   * from the server snapshot to restore convergence.
   */
  onCausalGapExceeded?: () => void;

  constructor(maxBufferSize = 100) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Attempts to apply `envelope.op` to `doc`.
   * Returns true if the operation was applied, false if buffered.
   *
   * Call this for EVERY incoming remote operation.
   */
  applyOrBuffer(envelope: OperationEnvelope, doc: RGADocument): boolean {
    // Duplicate detection by server seq
    if (envelope.seq > 0 && this.appliedSeqs.has(envelope.seq)) return true;

    // Duplicate detection by client key (for ops not yet assigned a server seq)
    const clientKey = `${envelope.sessionId}:${envelope.clientSeq}`;
    if (this.appliedClientKeys.has(clientKey)) return true;

    const applied = doc.applyOperation(envelope.op);

    if (applied) {
      this.recordApplied(envelope);
      this.flushBuffer(doc);
      return true;
    } else {
      // Could not apply — causal gap. Buffer and retry later.
      if (this.buffer.length < this.maxBufferSize) {
        this.buffer.push({ envelope, attempts: 1, firstSeen: Date.now() });
      }
      // If buffer is full, force-apply (lose causal ordering — last resort)
      if (this.buffer.length >= this.maxBufferSize) {
        this.forceApplyBuffer(doc);
      }
      return false;
    }
  }

  private recordApplied(envelope: OperationEnvelope): void {
    if (envelope.seq > 0) {
      this.appliedSeqs.add(envelope.seq);
      if (envelope.seq > this._maxAppliedSeq) this._maxAppliedSeq = envelope.seq;
    }
    const clientKey = `${envelope.sessionId}:${envelope.clientSeq}`;
    this.appliedClientKeys.add(clientKey);
  }

  /**
   * Re-attempts all buffered operations. Called after every successful apply.
   */
  private flushBuffer(doc: RGADocument): void {
    let progress = true;
    while (progress && this.buffer.length > 0) {
      progress = false;
      const stillPending: PendingOp[] = [];

      for (const pending of this.buffer) {
        const applied = doc.applyOperation(pending.envelope.op);
        if (applied) {
          this.recordApplied(pending.envelope);
          progress = true;
        } else {
          pending.attempts++;
          stillPending.push(pending);
        }
      }

      this.buffer = stillPending;
    }
  }

  private forceApplyBuffer(doc: RGADocument): void {
    // We cannot safely apply ops whose causal predecessors are missing.
    // Mutating the 'after' UID would cause different replicas to converge to
    // different orderings, permanently breaking convergence.
    //
    // Instead: discard the buffer and request a full state reload from the
    // server snapshot. This is the safe fallback — convergence is preserved
    // by letting the server's authoritative snapshot replace local state.
    const droppedCount = this.buffer.length;
    this.buffer = [];

    if (this.onCausalGapExceeded) {
      this.onCausalGapExceeded();
    }

    // Log at warn level — this should be rare in practice
    console.warn(
      `[OperationLog] Causal buffer overflow (${droppedCount} ops dropped). ` +
      `Full state reload required.`,
    );
  }

  /**
   * Returns the list of operations still awaiting application.
   */
  getPendingOps(): readonly PendingOp[] {
    return this.buffer;
  }

  /**
   * Returns the highest applied server seq, or 0 if none.
   * O(1) — maintained by recordApplied().
   */
  getMaxAppliedSeq(): number {
    return this._maxAppliedSeq;
  }

  /**
   * Returns true if the operation (by UID) has already been applied.
   */
  hasApplied(envelope: OperationEnvelope): boolean {
    if (envelope.seq > 0 && this.appliedSeqs.has(envelope.seq)) return true;
    const clientKey = `${envelope.sessionId}:${envelope.clientSeq}`;
    return this.appliedClientKeys.has(clientKey);
  }
}
