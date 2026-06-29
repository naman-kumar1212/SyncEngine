/**
 * Client-side RGA CRDT — identical algorithm to server-side rga-document.ts.
 * Runs in the browser without any server dependency.
 *
 * Additional features for the client:
 *   - Local operation generation with Lamport clock
 *   - Offline operation queue
 *   - Batch text diff → operations conversion (for paste events)
 */

import { uidKey, compareUID, ROOT_UID } from '../../shared/types/operation';
import type { InsertOperation, DeleteOperation, RGAOperation, UID } from '../../shared/types/operation';
import type { SerializedRGANode } from '../../shared/types/document';

interface RGANode {
  uid: UID;
  value: string;
  tombstoned: boolean;
  prev: RGANode | null;
  next: RGANode | null;
}

export class ClientRGADocument {
  private root: RGANode;
  private index: Map<string, RGANode>;
  private _siteId: string;
  private _clock: number;
  private _length: number;

  constructor(siteId: string, initialClock = 0) {
    this._siteId = siteId;
    this._clock = initialClock;
    this._length = 0;
    this.root = { uid: { ...ROOT_UID }, value: '', tombstoned: false, prev: null, next: null };
    this.index = new Map([[uidKey(ROOT_UID), this.root]]);
  }

  get siteId(): string { return this._siteId; }
  get clock(): number { return this._clock; }
  get length(): number { return this._length; }

  // ── Local operation generation ─────────────────────────────────────────────

  /**
   * Creates an insert operation for inserting `char` at visible character index `index`.
   * Also applies it locally (optimistic update).
   */
  localInsert(index: number, char: string): InsertOperation {
    this._clock++;
    const uid: UID = { clock: this._clock, siteId: this._siteId };
    const after = this.getAfterUID(index);
    const op: InsertOperation = { type: 'INSERT', uid, after, value: char };
    this.applyInsert(op);
    return op;
  }

  /**
   * Creates a delete operation for the visible character at `index`.
   * Also applies it locally (optimistic update).
   */
  localDelete(index: number): DeleteOperation | null {
    const uid = this.indexToUID(index + 1); // +1 because index is 0-based
    if (!uid) return null;
    const op: DeleteOperation = { type: 'DELETE', uid };
    this.applyDelete(op);
    return op;
  }

  // ── Remote operation application ───────────────────────────────────────────

  applyInsert(op: InsertOperation): void {
    const key = uidKey(op.uid);
    if (this.index.has(key)) return;

    const afterKey = op.after ? uidKey(op.after) : uidKey(ROOT_UID);
    const afterNode = this.index.get(afterKey);
    if (!afterNode) return; // Causal gap — should not happen on client if ops are ordered

    // Update local clock when applying remote ops
    if (op.uid.clock > this._clock) {
      this._clock = op.uid.clock;
    }

    let insertionPoint = afterNode;
    while (insertionPoint.next !== null && compareUID(insertionPoint.next.uid, op.uid) > 0) {
      insertionPoint = insertionPoint.next;
    }

    const node: RGANode = {
      uid: { ...op.uid },
      value: op.value,
      tombstoned: false,
      prev: insertionPoint,
      next: insertionPoint.next,
    };

    if (insertionPoint.next) insertionPoint.next.prev = node;
    insertionPoint.next = node;
    this.index.set(key, node);
    this._length++;
  }

  applyDelete(op: DeleteOperation): void {
    const node = this.index.get(uidKey(op.uid));
    if (!node || node.tombstoned) return;
    node.tombstoned = true;
    this._length--;
  }

  applyOperation(op: RGAOperation): void {
    if (op.type === 'INSERT') this.applyInsert(op);
    else this.applyDelete(op);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  toText(): string {
    const parts: string[] = [];
    let node = this.root.next;
    while (node) {
      if (!node.tombstoned) parts.push(node.value);
      node = node.next;
    }
    return parts.join('');
  }

  indexToUID(targetIdx: number): UID | null {
    let idx = 0;
    let node = this.root.next;
    while (node) {
      if (!node.tombstoned) {
        idx++;
        if (idx === targetIdx) return { ...node.uid };
      }
      node = node.next;
    }
    return null;
  }

  getAfterUID(index: number): UID | null {
    if (index === 0) return null;
    return this.indexToUID(index);
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  serialize(): SerializedRGANode[] {
    const nodes: SerializedRGANode[] = [];
    let node = this.root.next;
    while (node) {
      nodes.push({ clock: node.uid.clock, siteId: node.uid.siteId, value: node.value, tombstoned: node.tombstoned });
      node = node.next;
    }
    return nodes;
  }

  static deserialize(nodes: SerializedRGANode[], siteId: string, clock = 0): ClientRGADocument {
    const doc = new ClientRGADocument(siteId, clock);
    let prev = doc.root;
    for (const n of nodes) {
      const node: RGANode = { uid: { clock: n.clock, siteId: n.siteId }, value: n.value, tombstoned: n.tombstoned, prev, next: null };
      prev.next = node;
      doc.index.set(uidKey(node.uid), node);
      if (!n.tombstoned) doc._length++;
      if (n.clock > doc._clock) doc._clock = n.clock;
      prev = node;
    }
    return doc;
  }

  /**
   * Converts a text diff (before → after) into a sequence of RGA operations.
   * Used to handle paste events and other bulk text mutations.
   * Simple LCS-based diff for small changes; for large docs use a proper diff library.
   */
  diffToOperations(before: string, after: string): RGAOperation[] {
    const ops: RGAOperation[] = [];
    // Simple character-level diff using edit distance approach
    let i = 0;
    let j = 0;
    const beforeChars = [...before];
    const afterChars = [...after];

    // Find common prefix
    while (i < beforeChars.length && i < afterChars.length && beforeChars[i] === afterChars[i]) i++;
    const prefixLen = i;

    // Find common suffix
    let bi = beforeChars.length - 1;
    let ai = afterChars.length - 1;
    while (bi >= prefixLen && ai >= prefixLen && beforeChars[bi] === afterChars[ai]) { bi--; ai--; }

    // Delete chars in the changed region of before
    for (let k = bi; k >= prefixLen; k--) {
      const delOp = this.localDelete(k);
      if (delOp) ops.push(delOp);
    }

    // Insert chars in the changed region of after
    for (let k = prefixLen; k <= ai; k++) {
      // After deletions, the insert position shifts
      const insertIdx = k; // This is the visible index in the current (post-delete) doc
      const insOp = this.localInsert(insertIdx, afterChars[k]);
      ops.push(insOp);
    }

    return ops;
  }
}
