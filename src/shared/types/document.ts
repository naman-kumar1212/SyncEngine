/**
 * Document and revision data models.
 */

export type DocumentPermission = 'owner' | 'editor' | 'viewer';

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isDeleted: boolean;
}

export interface DocumentWithPermission extends Document {
  readonly role: DocumentPermission;
}

/**
 * A named revision (checkpoint) in the document history.
 */
export interface Revision {
  readonly id: string;
  readonly docId: string;
  readonly seq: number;        // Server seq at this revision
  readonly label: string | null;
  readonly createdBy: string;  // userId
  readonly createdAt: string;
}

/**
 * A serialized CRDT snapshot stored in PostgreSQL.
 * Loading a document = deserialize latest snapshot + replay ops since snapshot.seq.
 */
export interface SnapshotRecord {
  readonly id: string;
  readonly docId: string;
  readonly seq: number;        // All operations up through this seq are captured
  readonly data: SerializedRGANode[];  // Full CRDT state
  readonly textHash: string;   // SHA-256 of the plain text at this snapshot (integrity check)
  readonly createdAt: string;
}

/**
 * Portable RGA node representation for JSON serialization.
 * Strips linked-list pointers; order in the array IS the document order.
 */
export interface SerializedRGANode {
  readonly clock: number;
  readonly siteId: string;
  readonly value: string;
  readonly tombstoned: boolean;
}

/**
 * A paginated page of operations for the history view.
 */
export interface HistoryPage {
  readonly ops: OperationSummary[];
  readonly total: number;
  readonly from: number;
  readonly to: number;
}

export interface OperationSummary {
  readonly seq: number;
  readonly userId: string;
  readonly displayName: string;
  readonly opType: 'INSERT' | 'DELETE';
  readonly preview: string;    // Short human-readable description
  readonly timestamp: string;
}

// Import used by SnapshotRecord
import type { OperationEnvelope } from './operation';
export type { OperationEnvelope };
