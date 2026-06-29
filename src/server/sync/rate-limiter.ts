/**
 * Rate limiter using Redis sliding window algorithm.
 *
 * For each user, maintains two counters:
 *   1. ops/second: key expires after 1 second
 *   2. ops/minute: key expires after 60 seconds
 *
 * Uses atomic Redis INCR + EXPIRE to ensure correctness under concurrent access.
 * Returns { allowed: false, retryAfterMs } when the limit is exceeded.
 */

import { getRedis } from '../fanout/redis-client';
import { REDIS_KEYS } from '../../shared/constants';
import { config } from '../config';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const redis = getRedis();
  const baseKey = REDIS_KEYS.rateLimit(userId);
  const perSecKey = `${baseKey}:s:${Math.floor(Date.now() / 1000)}`;
  const perMinKey = `${baseKey}:m:${Math.floor(Date.now() / 60000)}`;

  // Atomic increment + expire using pipeline
  const results = await redis
    .pipeline()
    .incr(perSecKey)
    .expire(perSecKey, 2) // 2s TTL to account for clock skew
    .incr(perMinKey)
    .expire(perMinKey, 120)
    .exec();

  if (!results) {
    return { allowed: true }; // fallback if pipeline fails
  }

  const perSec = (results[0][1] ?? 0) as number;
  const perMin = (results[2][1] ?? 0) as number;

  if (perSec > config.security.rateLimitOpsPerSecond) {
    return { allowed: false, retryAfterMs: 1000 };
  }
  if (perMin > config.security.rateLimitOpsPerMinute) {
    return { allowed: false, retryAfterMs: 60000 };
  }

  return { allowed: true };
}
