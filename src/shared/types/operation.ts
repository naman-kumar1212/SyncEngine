/**
 * Core CRDT types shared between client and server.
 * These are the fundamental building blocks of the RGA (Replicated Growable Array) algorithm.
 */

// ─── Unique Identifier ────────────────────────────────────────────────────────

/**
 * A Lamport clock–based globally unique identifier for every RGA node.
 * Two UIDs are considered equal only if BOTH clock and siteId match.
 */
export interface UID {
  readonly clock: number;  // Lamport timestamp, monotonically increasing per site
  readonly siteId: string; // UUID of the client/site that created this node
}

/**
 * Deterministic total order over UIDs.
 *   - First compare by clock (higher clock = happened later)
 *   - Break ties by siteId (lexicographic — arbitrary but deterministic)
 *
 * This ordering is the core of the RGA convergence guarantee:
 * any two replicas seeing the same operations produce the same sequence.
 *
 * @returns negative if a < b, 0 if a === b, positive if a > b
 */
export function compareUID(a: UID, b: UID): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.siteId < b.siteId) return -1;
  if (a.siteId > b.siteId) return 1;
  return 0;
}

/**
 * String key for use as Map keys. Canonical form: "clock:siteId".
 */
export function uidKey(uid: UID): string {
  return `${uid.clock}:${uid.siteId}`;
}

/**
 * The sentinel "root" UID — represents the virtual head of the document.
 * Insertions with after=null are anchored to this root.
 */
export const ROOT_UID: UID = Object.freeze({ clock: 0, siteId: '__root__' });

// ─── Operations ───────────────────────────────────────────────────────────────

export type OperationType = 'INSERT' | 'DELETE' | 'FORMAT';

/**
 * An RGA insert operation.
 * Inserts a single character `value` at a position uniquely identified by `uid`,
 * anchored after the node with UID `after` (null = after root = beginning of document).
 *
 * IMMUTABILITY: operations are value objects — never mutate after creation.
 */
export interface InsertOperation {
  readonly type: 'INSERT';
  readonly uid: UID;         // Globally unique ID for this new character node
  readonly after: UID | null; // Insert after this node; null = beginning of document
  readonly value: any;       // Single character string OR Slate node object (ElementNode/TextNode)
}

/**
 * An RGA delete operation.
 * Tombstones the node identified by `uid`. The node remains in the linked list
 * but is excluded from the visible text. Deletions are idempotent.
 */
export interface DeleteOperation {
  readonly type: 'DELETE';
  readonly uid: UID;         // UID of the node to tombstone
}

/**
 * An RGA format operation.
 * Applies rich-text attributes to an existing node.
 */
export interface FormatOperation {
  readonly type: 'FORMAT';
  readonly uid: UID;
  readonly attributes: Record<string, any>;
}

export type RGAOperation = InsertOperation | DeleteOperation | FormatOperation;

// ─── Operation Envelope ───────────────────────────────────────────────────────

/**
 * Full wire/storage representation of an operation.
 * The server assigns `id`, `seq`, and `timestamp`; the client provides the rest.
 */
export interface OperationEnvelope {
  readonly id: string;              // Server-assigned UUID
  readonly docId: string;           // Target document
  readonly sessionId: string;       // Session that produced this op
  readonly userId: string;          // User who produced this op
  readonly op: RGAOperation;        // The actual CRDT operation
  readonly seq: number;             // Server-assigned monotonic sequence per document
  readonly clientSeq: number;       // Client's local counter (for ACK matching & dedup)
  readonly timestamp: string;       // ISO 8601 server timestamp
  readonly vectorClock: VectorClock; // Sender's vector clock at send time
  readonly nonce: string;           // UUID for replay-attack prevention
}

// ─── Vector Clock ─────────────────────────────────────────────────────────────

/**
 * A vector clock maps siteId → logical clock value.
 * Used for causal ordering and determining which ops a client has already seen.
 */
export type VectorClock = Readonly<Record<string, number>>;

export function mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
  const result: Record<string, number> = { ...a };
  for (const [site, clock] of Object.entries(b)) {
    result[site] = Math.max(result[site] ?? 0, clock);
  }
  return result;
}

export function incrementClock(vc: VectorClock, siteId: string): VectorClock {
  return { ...vc, [siteId]: (vc[siteId] ?? 0) + 1 };
}
