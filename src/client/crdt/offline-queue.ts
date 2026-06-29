/**
 * Offline operation queue — persists unacknowledged operations.
 *
 * Operations are buffered here when:
 *   - The client is disconnected (network is down)
 *   - An operation has been sent but not yet ACK'd by the server
 *
 * On reconnect:
 *   1. The client receives missedOps in JOIN_ACK
 *   2. It applies them to the local CRDT
 *   3. It re-sends all buffered ops from this queue
 *   4. As each ACK arrives, the corresponding op is removed from the queue
 *
 * Storage: localStorage (survives page refresh) with in-memory fallback.
 */

import type { RGAOperation } from '../../shared/types/operation';

export interface QueuedOperation {
  clientSeq: number;
  op: RGAOperation;
  nonce: string;
  timestamp: number; // Unix ms when enqueued
  attempts: number;  // Send attempts (for exponential backoff display)
}

const STORAGE_KEY = 'sync-engine:offline-queue';

export class OfflineQueue {
  private queue: QueuedOperation[] = [];
  private readonly docId: string;
  private readonly useStorage: boolean;

  constructor(docId: string) {
    this.docId = docId;
    this.useStorage = typeof localStorage !== 'undefined';
    this.load();
  }

  private storageKey(): string {
    return `${STORAGE_KEY}:${this.docId}`;
  }

  private load(): void {
    if (!this.useStorage) return;
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (raw) this.queue = JSON.parse(raw);
    } catch {
      this.queue = [];
    }
  }

  private persist(): void {
    if (!this.useStorage) return;
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(this.queue));
    } catch {
      // localStorage might be full — continue without persistence
    }
  }

  enqueue(op: QueuedOperation): void {
    this.queue.push(op);
    this.persist();
  }

  /**
   * Removes the operation with the given clientSeq (on ACK receipt).
   */
  acknowledge(clientSeq: number): void {
    this.queue = this.queue.filter((op) => op.clientSeq !== clientSeq);
    this.persist();
  }

  /**
   * Returns all queued operations in order (oldest first).
   */
  getAll(): readonly QueuedOperation[] {
    return this.queue;
  }

  get size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    if (this.useStorage) localStorage.removeItem(this.storageKey());
  }

  /**
   * Increments the attempt counter for an operation (for UI display).
   */
  incrementAttempts(clientSeq: number): void {
    const op = this.queue.find((q) => q.clientSeq === clientSeq);
    if (op) op.attempts++;
  }
}
