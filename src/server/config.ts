/**
 * Server configuration loaded from environment variables.
 * All settings have sensible defaults for local development.
 */

import 'dotenv/config';

function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function intEnv(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  env: (process.env.NODE_ENV ?? 'development') as 'development' | 'production' | 'test',
  port: intEnv('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',

  database: {
    url: requireEnv('DATABASE_URL', 'postgresql://syncuser:syncpass@localhost:5432/syncengine'),
    poolMin: intEnv('DB_POOL_MIN', 2),
    poolMax: intEnv('DB_POOL_MAX', 20),
  },

  redis: {
    url: requireEnv('REDIS_URL', 'redis://localhost:6379'),
  },

  jwt: {
    privateKeyPath: process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.key',
    publicKeyPath: process.env.JWT_PUBLIC_KEY_PATH ?? './keys/public.key',
    accessExpiry: intEnv('JWT_ACCESS_EXPIRY', 900),
    refreshExpiry: intEnv('JWT_REFRESH_EXPIRY', 604800),
    // In development, a local secret is sufficient.
    // In production, JWT_SECRET MUST be set to a cryptographically random value (32+ bytes).
    // Failure to set this will throw at startup — intentional.
    secret: requireEnv('JWT_SECRET', process.env.NODE_ENV !== 'production' ? 'dev-secret-change-in-production' : undefined),
  },

  security: {
    replayWindowSeconds: intEnv('REPLAY_WINDOW_SECONDS', 300),
    rateLimitOpsPerSecond: intEnv('RATE_LIMIT_OPS_PER_SECOND', 100),
    rateLimitOpsPerMinute: intEnv('RATE_LIMIT_OPS_PER_MINUTE', 1000),
  },

  crdt: {
    snapshotOpsThreshold: intEnv('SNAPSHOT_OPS_THRESHOLD', 500),
    snapshotIntervalMs: intEnv('SNAPSHOT_INTERVAL_MS', 600_000),
    documentCacheTtlMs: intEnv('DOCUMENT_CACHE_TTL_MS', 600_000),
    documentCacheMaxSize: intEnv('DOCUMENT_CACHE_MAX_SIZE', 200),
  },

  ws: {
    heartbeatIntervalMs: intEnv('WS_HEARTBEAT_INTERVAL_MS', 30_000),
    heartbeatTimeoutMs: intEnv('WS_HEARTBEAT_TIMEOUT_MS', 10_000),
    maxPayloadBytes: intEnv('WS_MAX_PAYLOAD_BYTES', 131_072),
    sendQueueMax: intEnv('WS_SEND_QUEUE_MAX', 500),
  },

  log: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
} as const;

export type Config = typeof config;
