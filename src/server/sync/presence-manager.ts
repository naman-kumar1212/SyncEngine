/**
 * Presence manager — tracks cursor positions, typing indicators, and active users.
 *
 * Presence data is EPHEMERAL — it lives in Redis with a TTL and in memory on
 * each worker. It is NOT durably stored in PostgreSQL (except for audit purposes).
 *
 * Design:
 *   - Each connected session has a UserPresence record
 *   - Cursor positions are anchored to RGA node UIDs (stable against concurrent inserts)
 *   - Typing indicators are set by the client and auto-expire after 3 seconds
 *   - Presence is broadcast to all clients in the same document via Redis pub/sub
 */

import { getRedis } from '../fanout/redis-client';
import { publishPresence, publishUserLeft } from '../fanout/redis-pubsub';
import type { UserPresence, CursorPosition } from '../../shared/types/presence';
import { REDIS_KEYS } from '../../shared/constants';
import { logger } from '../logger';

const PRESENCE_TTL_SECONDS = 60;
const PRESENCE_KEY_PREFIX = 'presence:doc:';

function presenceKey(docId: string, sessionId: string): string {
  return `${PRESENCE_KEY_PREFIX}${docId}:${sessionId}`;
}

/**
 * Upserts presence data for a session and broadcasts it.
 */
export async function updatePresence(
  docId: string,
  presence: UserPresence,
): Promise<void> {
  const redis = getRedis();
  const key = presenceKey(docId, presence.sessionId);
  await redis.set(key, JSON.stringify(presence), 'EX', PRESENCE_TTL_SECONDS);
  await publishPresence(docId, presence);
}

/**
 * Removes presence for a disconnected session and notifies peers.
 */
export async function removePresence(
  docId: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  const redis = getRedis();
  const key = presenceKey(docId, sessionId);
  await redis.del(key);
  await publishUserLeft(docId, sessionId, userId);
  logger.debug({ docId, sessionId }, 'Presence removed');
}

/**
 * Returns all currently active presence records for a document.
 */
export async function getAllPresence(docId: string): Promise<UserPresence[]> {
  const redis = getRedis();
  const pattern = `${PRESENCE_KEY_PREFIX}${docId}:*`;
  const keys = await redis.keys(pattern);

  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  const presence: UserPresence[] = [];

  for (const val of values) {
    if (val) {
      try {
        presence.push(JSON.parse(val) as UserPresence);
      } catch {
        // Skip malformed entries
      }
    }
  }

  return presence;
}

/**
 * Refreshes the TTL for a presence record (call on each heartbeat/operation).
 */
export async function refreshPresenceTTL(
  docId: string,
  sessionId: string,
): Promise<void> {
  const redis = getRedis();
  const key = presenceKey(docId, sessionId);
  await redis.expire(key, PRESENCE_TTL_SECONDS);
}

/**
 * Builds an initial UserPresence for a newly joined session.
 */
export function buildInitialPresence(params: {
  sessionId: string;
  userId: string;
  displayName: string;
  color: string;
}): UserPresence {
  return {
    sessionId: params.sessionId,
    userId: params.userId,
    displayName: params.displayName,
    color: params.color,
    cursor: null,
    isTyping: false,
    lastSeen: new Date().toISOString(),
  };
}
