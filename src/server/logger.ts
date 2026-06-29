/**
 * Structured logger using pino.
 * In development: pretty-printed output.
 * In production: JSON lines (compatible with log aggregators like Loki, Datadog).
 */

import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.log.level,
  transport:
    config.env === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  base: { service: 'sync-engine' },
});

export type Logger = typeof logger;
