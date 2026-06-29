/**
 * Replay attack prevention.
 * Uses Redis as the primary store (fast, TTL-based) with PostgreSQL as fallback.
 *
 * For each incoming operation:
 *   1. Check if the nonce is in the Redis dedup set for this document
 *   2. If yes → reject (replay detected)
 *   3. If no  → add to Redis with TTL = REPLAY_WINDOW_SECONDS, proceed
 *
 * Nonces older than the window are automatically expired by Redis.
 */

import { getRedis } from '../fanout/redis-client';
import { REDIS_KEYS } from '../../shared/constants';
import { config } from '../config';
import { nonceExists } from '../persistence/operation-store';
import { logger } from '../logger';

/**
 * Returns true if the nonce has already been seen (replay detected).
 * Registers the nonce in Redis if it is new.
 *
 * Falls back to PostgreSQL nonce lookup if Redis is unavailable,
 * ensuring replay protection is maintained during Redis outages.
 */
export async function isReplay(docId: string, nonce: string): Promise<boolean> {
  const redis = getRedis();
  const key = REDIS_KEYS.replayNonce(docId, nonce);

  try {
    // SETNX with TTL: atomic "set if not exists"
    const set = await redis.set(key, '1', 'EX', config.security.replayWindowSeconds, 'NX');

    if (set === null) {
      // Redis already had this key → replay
      logger.warn({ docId, nonce }, 'Replay attack detected (Redis)');
      return true;
    }

    return false; // first time we've seen this nonce
  } catch (redisErr) {
    // Redis unavailable — fall back to PostgreSQL as the authoritative nonce store
    logger.warn({ redisErr, docId, nonce }, 'Redis unavailable for replay check, falling back to PostgreSQL');

    try {
      const exists = await nonceExists(nonce);
      if (exists) {
        logger.warn({ docId, nonce }, 'Replay attack detected (PostgreSQL fallback)');
        return true;
      }
      // Nonce is new — allow op to proceed
      // The nonce will be stored permanently when appendOperation() inserts the row.
      return false;
    } catch (pgErr) {
      // Both Redis and PG are unavailable — fail safe by REJECTING the operation
      // to prevent replay attacks during a full infrastructure outage.
      logger.error({ pgErr, docId, nonce }, 'Both Redis and PG unavailable for replay check — rejecting operation (fail-safe)');
      return true;
    }
  }
}

/**
 * Validates the operation timestamp is within the acceptable window.
 * Rejects operations that are too old or from the future.
 */
export function isTimestampValid(timestamp: string): boolean {
  const now = Date.now();
  const opTime = new Date(timestamp).getTime();
  const windowMs = config.security.replayWindowSeconds * 1000;
  return Math.abs(now - opTime) <= windowMs;
}
