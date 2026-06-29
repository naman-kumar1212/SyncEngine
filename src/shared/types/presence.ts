/**
 * Presence data models: cursor positions, user awareness, typing indicators.
 */

import type { UID } from './operation';

/**
 * Cursor position anchored to a specific RGA node UID.
 * Using UID instead of character index ensures cursor stays valid
 * even as concurrent insertions shift character positions.
 */
export interface CursorPosition {
  /** The cursor is positioned AFTER this node (null = beginning of document) */
  readonly afterUid: UID | null;
  readonly anchorUid: UID | null;  // Selection anchor (null = collapsed cursor)
}

export interface UserPresence {
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;     // Hex color assigned to this user
  readonly cursor: CursorPosition | null;
  readonly isTyping: boolean;
  readonly lastSeen: string;  // ISO 8601
}

export interface PresenceUpdate {
  readonly sessionId: string;
  readonly cursor: CursorPosition | null;
  readonly isTyping: boolean;
}
