/**
 * Redis client singleton using ioredis.
 * Creates separate instances for pub/sub (which must not be shared with regular commands)
 * and for regular commands (rate limiting, replay guard, presence, etc).
 */

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';

let commandClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let publisherClient: Redis | null = null;

function createClient(role: string): Redis {
  const client = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableOfflineQueue: true,
  });

  client.on('connect', () => logger.info({ role }, 'Redis connected'));
  client.on('error', (err) => logger.error({ err, role }, 'Redis error'));
  client.on('reconnecting', () => logger.warn({ role }, 'Redis reconnecting'));

  return client;
}

/** General-purpose Redis client for commands (GET, SET, INCR, etc.) */
export function getRedis(): Redis {
  if (!commandClient) commandClient = createClient('command');
  return commandClient;
}

/** Dedicated publish client — must not be used for subscribe */
export function getPublisher(): Redis {
  if (!publisherClient) publisherClient = createClient('publisher');
  return publisherClient;
}

/** Dedicated subscribe client — blocked while subscribed */
export function getSubscriber(): Redis {
  if (!subscriberClient) subscriberClient = createClient('subscriber');
  return subscriberClient;
}

export async function closeRedis(): Promise<void> {
  await Promise.all([
    commandClient?.quit(),
    publisherClient?.quit(),
    subscriberClient?.quit(),
  ]);
  commandClient = null;
  publisherClient = null;
  subscriberClient = null;
  logger.info('Redis clients closed');
}
