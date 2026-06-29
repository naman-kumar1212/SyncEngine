/**
 * Application-wide constants shared between client and server.
 */

export const PROTOCOL_VERSION = '1.0.0';

// WebSocket close codes (4000-4999 are application-defined)
export const WS_CLOSE_CODES = {
  NORMAL: 1000,
  AUTH_FAILED: 4001,
  PERMISSION_DENIED: 4003,
  DOCUMENT_NOT_FOUND: 4004,
  RATE_LIMITED: 4008,
  SLOW_CONSUMER: 4009,
} as const;

// Redis key namespaces
export const REDIS_KEYS = {
  docChannel: (docId: string) => `doc:${docId}:ops`,
  presenceChannel: (docId: string) => `doc:${docId}:presence`,
  rateLimit: (userId: string) => `rl:${userId}`,
  replayNonce: (docId: string, nonce: string) => `replay:${docId}:${nonce}`,
  sessionMeta: (sessionId: string) => `session:${sessionId}`,
} as const;

// Max text length per operation value (single codepoint check)
export const MAX_OPERATION_VALUE_LENGTH = 4; // up to 4 bytes for a Unicode codepoint

export const ROOT_SITE_ID = '__root__';
export const ROOT_CLOCK = 0;

// Snapshot & compaction
export const DEFAULT_SNAPSHOT_OPS_THRESHOLD = 500;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
