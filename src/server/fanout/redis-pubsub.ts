/**
 * Redis Pub/Sub fan-out for horizontal scaling.
 *
 * When a worker receives an operation from a client, it:
 *   1. Persists the op to PostgreSQL
 *   2. Publishes the serialized envelope to a Redis channel: `doc:{docId}:ops`
 *   3. All workers (including itself) subscribe to this channel
 *   4. Each worker broadcasts the op to its locally connected clients for that doc
 *
 * This decouples the "who received the op" concern from "who needs to know about it".
 * Any number of workers can scale horizontally — Redis is the message bus.
 *
 * Presence updates use a separate channel: `doc:{docId}:presence`
 */

import { getPublisher, getSubscriber } from './redis-client';
import { REDIS_KEYS } from '../../shared/constants';
import type { OperationEnvelope } from '../../shared/types/operation';
import type { UserPresence } from '../../shared/types/presence';
import { logger } from '../logger';

type OperationHandler = (envelope: OperationEnvelope) => void;
type PresenceHandler = (presence: UserPresence) => void;
type UserLeftHandler = (data: { sessionId: string; userId: string; docId: string }) => void;

const opHandlers: Map<string, Set<OperationHandler>> = new Map();
const presenceHandlers: Map<string, Set<PresenceHandler>> = new Map();
const userLeftHandlers: Set<UserLeftHandler> = new Set();

let subscribed = false;

/**
 * Publishes a persisted operation to all workers via Redis.
 */
export async function publishOperation(envelope: OperationEnvelope): Promise<void> {
  const channel = REDIS_KEYS.docChannel(envelope.docId);
  await getPublisher().publish(channel, JSON.stringify({ type: 'op', envelope }));
}

/**
 * Publishes a presence update (cursor move, typing indicator).
 */
export async function publishPresence(docId: string, presence: UserPresence): Promise<void> {
  const channel = REDIS_KEYS.presenceChannel(docId);
  await getPublisher().publish(channel, JSON.stringify({ type: 'presence', presence }));
}

/**
 * Publishes a user-left notification.
 */
export async function publishUserLeft(
  docId: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  const channel = REDIS_KEYS.presenceChannel(docId);
  await getPublisher().publish(
    channel,
    JSON.stringify({ type: 'user_left', sessionId, userId, docId }),
  );
}

/**
 * Subscribes to op and presence channels for a document on this worker.
 * Handlers are called for every message, including messages published by this worker.
 */
export function subscribeToDocument(
  docId: string,
  onOp: OperationHandler,
  onPresence: PresenceHandler,
): void {
  const opChannel = REDIS_KEYS.docChannel(docId);
  const presChannel = REDIS_KEYS.presenceChannel(docId);

  if (!opHandlers.has(docId)) opHandlers.set(docId, new Set());
  if (!presenceHandlers.has(docId)) presenceHandlers.set(docId, new Set());

  opHandlers.get(docId)!.add(onOp);
  presenceHandlers.get(docId)!.add(onPresence);

  const subscriber = getSubscriber();
  subscriber.subscribe(opChannel, presChannel, (err, count) => {
    if (err) logger.error({ err, docId }, 'Redis subscribe error');
    else logger.debug({ docId, channels: count }, 'Subscribed to document channels');
  });

  ensureMessageRouter();
}

/**
 * Unsubscribes handlers for a document (when the last client leaves).
 */
export function unsubscribeFromDocument(
  docId: string,
  onOp: OperationHandler,
  onPresence: PresenceHandler,
): void {
  opHandlers.get(docId)?.delete(onOp);
  presenceHandlers.get(docId)?.delete(onPresence);

  const noMoreOp = (opHandlers.get(docId)?.size ?? 0) === 0;
  const noMorePres = (presenceHandlers.get(docId)?.size ?? 0) === 0;

  if (noMoreOp && noMorePres) {
    opHandlers.delete(docId);
    presenceHandlers.delete(docId);
    const subscriber = getSubscriber();
    subscriber.unsubscribe(
      REDIS_KEYS.docChannel(docId),
      REDIS_KEYS.presenceChannel(docId),
    );
  }
}

export function onUserLeft(handler: UserLeftHandler): () => void {
  userLeftHandlers.add(handler);
  return () => userLeftHandlers.delete(handler);
}

/** Routes Redis messages to the correct document handler. */
function ensureMessageRouter(): void {
  if (subscribed) return;
  subscribed = true;

  const subscriber = getSubscriber();
  subscriber.on('message', (channel: string, message: string) => {
    try {
      const data = JSON.parse(message);

      // Route by channel prefix
      if (channel.endsWith(':ops')) {
        const docId = extractDocId(channel, ':ops');
        if (data.type === 'op') {
          opHandlers.get(docId)?.forEach((h) => h(data.envelope));
        }
      } else if (channel.endsWith(':presence')) {
        const docId = extractDocId(channel, ':presence');
        if (data.type === 'presence') {
          presenceHandlers.get(docId)?.forEach((h) => h(data.presence));
        } else if (data.type === 'user_left') {
          userLeftHandlers.forEach((h) => h(data));
        }
      }
    } catch (err) {
      logger.error({ err, channel }, 'Failed to parse Redis message');
    }
  });
}

function extractDocId(channel: string, suffix: string): string {
  // channel format: "doc:{docId}:ops" or "doc:{docId}:presence"
  return channel.replace('doc:', '').replace(suffix, '');
}
