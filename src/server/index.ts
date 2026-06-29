/**
 * Server entry point.
 * Bootstraps HTTP + WebSocket servers, connects to PostgreSQL and Redis,
 * and handles graceful shutdown.
 */

import http from 'http';
import { config } from './config';
import { logger } from './logger';
import { createHttpServer } from './transport/http-server';
import { createWebSocketServer } from './transport/websocket-server';
import { getPool, closePool } from './persistence/db';
import { closeRedis, getRedis } from './fanout/redis-client';

async function bootstrap() {
  logger.info({ env: config.env, port: config.port }, 'Starting Sync Engine');

  // ── 1. Verify database connectivity ─────────────────────────────────────
  try {
    await getPool().query('SELECT 1');
    logger.info('PostgreSQL connected');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to PostgreSQL');
    process.exit(1);
  }

  // ── 2. Verify Redis connectivity ─────────────────────────────────────────
  try {
    await getRedis().ping();
    logger.info('Redis connected');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to Redis');
    process.exit(1);
  }

  // ── 3. Create HTTP + WebSocket servers ───────────────────────────────────
  const app = createHttpServer();
  const httpServer = http.createServer(app);
  const wss = createWebSocketServer(httpServer);

  // ── 4. Start listening ───────────────────────────────────────────────────
  httpServer.listen(config.port, config.host, () => {
    logger.info(`Server listening on ${config.host}:${config.port}`);
    logger.info(`WebSocket: ws://${config.host}:${config.port}/ws`);
    logger.info(`Health:    http://${config.host}:${config.port}/health`);
  });

  // ── 5. Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new connections
    wss.close(() => logger.info('WebSocket server closed'));
    httpServer.close(async () => {
      logger.info('HTTP server closed');
      await Promise.all([closePool(), closeRedis()]);
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
}

bootstrap();
