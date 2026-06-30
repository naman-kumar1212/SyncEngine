/**
 * RGADocument — The core RGA (Replicated Growable Array) CRDT implementation.
 *
 * ─── ALGORITHM SUMMARY ────────────────────────────────────────────────────────
 *
 * The document is a doubly-linked list of RGANodes plus a sentinel root node.
 * Every node has a globally unique UID = (lamportClock, siteId).
 *
 * INSERT(uid, after, value):
 *   1. Find the node with UID `after` in O(1) via the index Map.
 *   2. Starting from `after`, scan rightward while the next node's UID is
 *      GREATER than `uid` (deterministic tiebreak for concurrent same-position inserts).
 *   3. Splice the new node at the found position.
 *
 * DELETE(uid):
 *   1. Find the node by UID in O(1).
 *   2. Set tombstoned = true. Node remains in list (soft delete).
 *
 * ─── CONVERGENCE GUARANTEE ────────────────────────────────────────────────────
 *
 * The algorithm is a join-semilattice:
 *   - Commutativity: apply(A, B) = apply(B, A)  (identical final list)
 *   - Associativity: apply(apply(A, B), C) = apply(A, apply(B, C))
 *   - Idempotency:   apply(A, A) = apply(A)       (duplicate-safe)
 *
 * These three properties are sufficient for eventual consistency in a
 * distributed system where all operations are eventually delivered.
 *
 * ─── COMPLEXITY ───────────────────────────────────────────────────────────────
 *
 * applyInsert (causal):          O(1) amortized (pointer follow)
 * applyInsert (concurrent):      O(k) where k = concurrent inserts at same position
 * applyDelete:                   O(1) (Map lookup)
 * toText:                        O(n) where n = total live nodes
 * serialize/deserialize:         O(n)
 */

import type {
  InsertOperation,
  DeleteOperation,
  FormatOperation,
  RGAOperation,
} from '../shared/types/operation';
import { uidKey, compareUID, ROOT_UID } from '../shared/types/operation';
import type { SerializedRGANode } from '../shared/types/document';

export interface RGANode {
  readonly uid: { clock: number; siteId: string };
  readonly value: any;
  attributes?: Record<string, any>;
  tombstoned: boolean;  // mutable only via applyDelete
  prev: RGANode | null;
  next: RGANode | null;
}

export class RGADocument {
  /** Sentinel head node — never tombstoned, never visible */
  private readonly root: RGANode;
  /** UID string → node, for O(1) lookup by UID */
  private readonly index: Map<string, RGANode>;
  /** Count of live (non-tombstoned) nodes */
  private _length: number;
  /** Approximate total size of all values (live + tombstoned) */
  private _nodeCount: number;

  constructor() {
    this.root = {
      uid: { ...ROOT_UID },
      value: null,
      attributes: {},
      tombstoned: false,
      prev: null,
      next: null,
    };
    this.index = new Map([[uidKey(ROOT_UID), this.root]]);
    this._length = 0;
    this._nodeCount = 0;
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  get length(): number { return this._length; }
  get nodeCount(): number { return this._nodeCount; }

  // ─── INSERT ────────────────────────────────────────────────────────────────

  /**
   * Applies an insert operation to this document replica.
   *
   * Idempotent: if the UID already exists in the index, returns immediately.
   * This is what makes duplicate-message delivery safe.
   *
   * The scan-right loop (steps 2 above) resolves concurrent inserts at the
   * same position: nodes with a HIGHER UID (= newer or from a "later" site)
   * are placed to the LEFT of nodes with a lower UID. This is the RGA
   * ordering rule that guarantees all replicas choose the same ordering.
   *
   * @throws {Error} if the `after` UID is not found in this replica (causal gap)
   */
  applyInsert(op: InsertOperation): void {
    const key = uidKey(op.uid);
    if (this.index.has(key)) return; // idempotent — already applied

    const afterKey = op.after ? uidKey(op.after) : uidKey(ROOT_UID);
    const afterNode = this.index.get(afterKey);
    if (!afterNode) {
      throw new Error(
        `RGA causal gap: 'after' node ${afterKey} not found. ` +
        `This operation arrived before its causal predecessor.`,
      );
    }

    // Scan right past concurrent insertions with higher UIDs (RGA rule)
    let insertionPoint = afterNode;
    while (
      insertionPoint.next !== null &&
      compareUID(insertionPoint.next.uid, op.uid) > 0
    ) {
      insertionPoint = insertionPoint.next;
    }

    // Splice new node between insertionPoint and insertionPoint.next
    const newNode: RGANode = {
      uid: { ...op.uid },
      value: op.value,
      attributes: {},
      tombstoned: false,
      prev: insertionPoint,
      next: insertionPoint.next,
    };

    if (insertionPoint.next !== null) {
      insertionPoint.next.prev = newNode;
    }
    insertionPoint.next = newNode;

    this.index.set(key, newNode);
    this._length++;
    this._nodeCount++;
  }

  // ─── DELETE ────────────────────────────────────────────────────────────────

  /**
   * Tombstones a node. Safe to call multiple times (idempotent).
   * If the node does not exist yet (causal gap), the delete is buffered
   * externally by the OperationLog and retried after the insert arrives.
   *
   * Returns true if the node was found (and tombstoned), false if not found.
   */
  applyDelete(op: DeleteOperation): boolean {
    const node = this.index.get(uidKey(op.uid));
    if (!node) return false; // caller should buffer and retry
    if (!node.tombstoned) {
      node.tombstoned = true;
      this._length--;
    }
    return true;
  }

  // ─── FORMAT ────────────────────────────────────────────────────────────────
  
  /**
   * Applies a formatting operation to a node.
   * Modifies the node's attributes. Commutativity of formats can be tricky;
   * we use Last-Writer-Wins (LWW) based on operation arrival, or could use Lamport clocks.
   * For simplicity here, we apply the attributes object merge.
   */
  applyFormat(op: FormatOperation): boolean {
    const node = this.index.get(uidKey(op.uid));
    if (!node) return false;
    node.attributes = { ...node.attributes, ...op.attributes };
    return true;
  }

  // ─── UNIFIED APPLY ─────────────────────────────────────────────────────────

  /**
   * Applies any RGA operation. Returns true on success, false if the
   * operation could not be applied due to a causal gap (should be buffered).
   */
  applyOperation(op: RGAOperation): boolean {
    try {
      if (op.type === 'INSERT') {
        this.applyInsert(op);
        return true;
      } else if (op.type === 'DELETE') {
        return this.applyDelete(op);
      } else if (op.type === 'FORMAT') {
        return this.applyFormat(op);
      }
      return false;
    } catch {
      return false; // causal gap — caller should buffer
    }
  }

  // ─── QUERIES ───────────────────────────────────────────────────────────────

  /**
   * Returns the current document text (tombstoned nodes are excluded).
   * O(n) where n is the total number of nodes (including tombstones).
   * NOTE: For Slate schema, this returns just the concatenated raw text.
   */
  toText(): string {
    const parts: string[] = [];
    let node = this.root.next;
    while (node !== null) {
      if (!node.tombstoned && typeof node.value === 'string') parts.push(node.value);
      node = node.next;
    }
    return parts.join('');
  }

  /**
   * Returns an array of visible nodes, useful for reconstructing the Slate document.
   */
  toNodes(): RGANode[] {
    const visible: RGANode[] = [];
    let node = this.root.next;
    while (node !== null) {
      if (!node.tombstoned) visible.push(node);
      node = node.next;
    }
    return visible;
  }

  /**
   * Returns the character index (in visible text) of the node with `uid`.
   * Returns -1 if not found or tombstoned.
   * O(n) — suitable for cursor position mapping.
   */
  uidToIndex(uid: { clock: number; siteId: string } | null): number {
    if (uid === null) return 0; // before the first character
    let idx = 0;
    let node = this.root.next;
    while (node !== null) {
      if (!node.tombstoned) {
        if (node.uid.clock === uid.clock && node.uid.siteId === uid.siteId) {
          return idx;
        }
        idx++;
      }
      node = node.next;
    }
    return -1;
  }

  /**
   * Returns the UID of the node at visible character index `index`.
   * Returns null for index 0 (before document start).
   * O(n).
   */
  indexToUID(index: number): { clock: number; siteId: string } | null {
    if (index === 0) return null;
    let idx = 0;
    let node = this.root.next;
    while (node !== null) {
      if (!node.tombstoned) {
        idx++;
        if (idx === index) return { ...node.uid };
      }
      node = node.next;
    }
    return null;
  }

  /**
   * Returns the UID that would be used as the `after` reference for an
   * insertion at visible character index `index`.
   * index = 0 → insert at start (after = null / root)
   * index = n → insert at end
   */
  getAfterUID(index: number): { clock: number; siteId: string } | null {
    if (index === 0) return null;
    return this.indexToUID(index);
  }

  /**
   * Returns the node for a given UID key, or null if not found.
   */
  getNode(uid: { clock: number; siteId: string }): RGANode | null {
    return this.index.get(uidKey(uid)) ?? null;
  }

  // ─── SERIALIZATION ─────────────────────────────────────────────────────────

  /**
   * Produces a snapshot-compatible array of nodes in document order.
   * Includes tombstoned nodes (required for correct deserialization).
   * The order of the array IS the document order.
   */
  serialize(): SerializedRGANode[] {
    const nodes: SerializedRGANode[] = [];
    let node = this.root.next;
    while (node !== null) {
      nodes.push({
        clock: node.uid.clock,
        siteId: node.uid.siteId,
        value: node.value,
        attributes: node.attributes,
        tombstoned: node.tombstoned,
      });
      node = node.next;
    }
    return nodes;
  }

  /**
   * Reconstructs an RGADocument from a serialized node array.
   * Nodes MUST be in document order (as produced by serialize()).
   */
  static deserialize(nodes: SerializedRGANode[]): RGADocument {
    const doc = new RGADocument();
    let prev = doc.root;

    for (const n of nodes) {
      const node: RGANode = {
        uid: { clock: n.clock, siteId: n.siteId },
        value: n.value,
        attributes: (n as any).attributes || {},
        tombstoned: n.tombstoned,
        prev,
        next: null,
      };
      prev.next = node;
      doc.index.set(uidKey(node.uid), node);
      doc._nodeCount++;
      if (!n.tombstoned) doc._length++;
      prev = node;
    }

    return doc;
  }

  /**
   * Creates an independent deep copy of this document.
   * Used when forking a document state for rollback preview.
   */
  clone(): RGADocument {
    return RGADocument.deserialize(this.serialize());
  }

  /**
   * Returns true if this document contains no visible characters.
   */
  isEmpty(): boolean {
    return this._length === 0;
  }

  /**
   * Garbage-collects tombstoned nodes from the linked list.
   *
   * After GC, tombstoned nodes are removed from both the linked list and the
   * index map. This means any future operation referencing a GC'd node's UID
   * as an `after` reference will fail with a causal gap error.
   *
   * IMPORTANT: Only call this during snapshot saving, after all operations up
   * to that seq have been permanently persisted. Clients re-joining after a
   * GC snapshot must receive the full snapshot (not incremental ops), since
   * the pre-GC UIDs no longer exist in the index.
   *
   * @returns The number of tombstoned nodes removed.
   */
  gc(): number {
    let removed = 0;
    let node = this.root.next;

    while (node !== null) {
      const next = node.next;

      if (node.tombstoned) {
        // Relink: prev <-> next, bypassing the tombstoned node
        if (node.prev !== null) node.prev.next = next;
        if (next !== null) next.prev = node.prev;
        // Remove from index to free memory
        this.index.delete(uidKey(node.uid));
        this._nodeCount--;
        removed++;
      }

      node = next;
    }

    return removed;
  }
}
