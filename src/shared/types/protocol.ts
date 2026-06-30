/**
 * WebSocket protocol message types.
 * All messages are JSON-serialized and sent over the WebSocket connection.
 *
 * Client → Server: JOIN, OPERATION, PRESENCE, PING
 * Server → Client: JOIN_ACK, OP_ACK, BROADCAST, PRESENCE_UPDATE, ERROR, PONG
 */

import type { RGAOperation, OperationEnvelope, VectorClock } from './operation';
import type { SerializedRGANode } from './document';
import type { UserPresence, PresenceUpdate } from './presence';

// ─── Client → Server ──────────────────────────────────────────────────────────

/**
 * First message after WebSocket connection. Contains auth token and the
 * last server sequence number the client has seen (0 for fresh join).
 */
export interface JoinMessage {
  readonly type: 'JOIN';
  readonly docId?: string;      // Optional for global notification connection
  readonly token: string;       // JWT access token
  readonly lastSeq: number;     // 0 = fresh; >0 = reconnect, request missed ops
  readonly clientId: string;    // Stable client UUID (persisted in localStorage)
}

/**
 * An edit operation from the client. The server will assign a server-side seq.
 */
export interface OperationMessage {
  readonly type: 'OPERATION';
  readonly docId: string;
  readonly clientSeq: number;   // Client's own monotonic counter for this session
  readonly op: RGAOperation;
  readonly vectorClock: VectorClock;
  readonly nonce: string;       // UUID — replay attack prevention
}

/**
 * Cursor position or typing indicator update. Sent on a best-effort basis.
 */
export interface PresenceMessage {
  readonly type: 'PRESENCE';
  readonly docId: string;
  readonly update: PresenceUpdate;
}

export interface PresenceCursorMessage {
  readonly type: 'PRESENCE_CURSOR';
  readonly docId: string;
  readonly update: {
    readonly sessionId: string;
    readonly cursor: any; // Using any for brevity here, should be CursorPosition
  };
}

export interface PresenceTypingMessage {
  readonly type: 'PRESENCE_TYPING';
  readonly docId: string;
  readonly isTyping: boolean;
}

export interface PingMessage {
  readonly type: 'PING';
  readonly timestamp: number;   // Unix ms — echoed back in PONG for RTT measurement
}

export type ClientMessage = JoinMessage | OperationMessage | PresenceMessage | PresenceCursorMessage | PresenceTypingMessage | PingMessage;

// ─── Server → Client ──────────────────────────────────────────────────────────

/**
 * Sent immediately after a successful JOIN.
 * Contains the current document snapshot + any operations the client missed.
 */
export interface JoinAckMessage {
  readonly type: 'JOIN_ACK';
  readonly sessionId: string;
  readonly siteId: string;        // UUID the client MUST use for all future UID generation
  readonly snapshot: {
    readonly seq: number;         // Operations through this seq are encoded in nodes
    readonly nodes: SerializedRGANode[];
  };
  readonly missedOps: OperationEnvelope[];  // Ops since lastSeq (for reconnect)
  readonly presence: UserPresence[];        // All currently connected users
}

/**
 * Acknowledgement for a client's OPERATION. Contains the server-assigned seq.
 */
export interface OpAckMessage {
  readonly type: 'OP_ACK';
  readonly clientSeq: number;     // Echoes the client's counter
  readonly serverSeq: number;     // Server-assigned monotonic sequence
  readonly timestamp: string;     // Server timestamp
}

/**
 * An operation from another client, broadcast to all peers in the document session.
 */
export interface BroadcastMessage {
  readonly type: 'BROADCAST';
  readonly envelope: OperationEnvelope;
}

/**
 * A presence update from another user (cursor move, typing indicator).
 */
export interface PresenceBroadcast {
  readonly type: 'PRESENCE_UPDATE';
  readonly presence: UserPresence;
}

/**
 * A user has disconnected from the document session.
 */
export interface UserLeftMessage {
  readonly type: 'USER_LEFT';
  readonly sessionId: string;
  readonly userId: string;
}

export interface PongMessage {
  readonly type: 'PONG';
  readonly timestamp: number;   // Echoed from PING
  readonly serverTime: number;  // Server's Unix ms
}

export interface ErrorMessage {
  readonly type: 'ERROR';
  readonly code: ErrorCode;
  readonly message: string;
  readonly clientSeq?: number;  // Present if the error is in response to an operation
}

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'DOCUMENT_NOT_FOUND'
  | 'INVALID_OPERATION'
  | 'RATE_LIMITED'
  | 'REPLAY_DETECTED'
  | 'SLOW_CONSUMER'
  | 'SERVER_ERROR';

export interface PresenceCursorBroadcast {
  readonly type: 'PRESENCE_CURSOR_UPDATE';
  readonly sessionId: string;
  readonly cursor: any; // CursorPosition
}

export interface PresenceTypingBroadcast {
  readonly type: 'PRESENCE_TYPING_UPDATE';
  readonly sessionId: string;
  readonly isTyping: boolean;
}

export interface ActivityBroadcast {
  readonly type: 'ACTIVITY_EVENT';
  readonly eventType: string;
  readonly payload: any;
}

export interface NotificationBroadcast {
  readonly type: 'NOTIFICATION_CREATED';
  readonly notification: any;
}

export type ServerMessage =
  | JoinAckMessage
  | OpAckMessage
  | BroadcastMessage
  | PresenceBroadcast
  | PresenceCursorBroadcast
  | PresenceTypingBroadcast
  | ActivityBroadcast
  | NotificationBroadcast
  | UserLeftMessage
  | PongMessage
  | ErrorMessage;
