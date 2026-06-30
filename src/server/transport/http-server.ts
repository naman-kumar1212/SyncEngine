/**
 * Express HTTP server factory.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { getPool } from '../persistence/db';
import { getRedis } from '../fanout/redis-client';
import { getCacheStats } from '../sync/document-cache';
import { getStats as getSessionStats } from '../transport/session-manager';
import authRouter from '../api/routes/auth';
import documentsRouter from '../api/routes/documents';
import historyRouter from '../api/routes/history';
import restoreRouter from '../api/routes/restore';
import invitesRouter from '../api/routes/invites';
import notificationsRouter from '../api/routes/notifications';
import dashboardRouter from '../api/routes/dashboard';
import { logger } from '../logger';
import { config } from '../config';

export function createHttpServer() {
  const app = express();

  // ── Security middleware ──────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: config.env === 'production'
      ? process.env.ALLOWED_ORIGINS?.split(',')
      : ['http://localhost:3001', 'http://localhost:5173'],
    credentials: true,
  }));

  // ── Request processing ───────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(compression());
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.path === '/health',
  }));

  // ── Health check (for Docker healthcheck + load balancer) ────────────────
  app.get('/health', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      await getRedis().ping();
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        cache: getCacheStats(),
        sessions: getSessionStats(),
      });
    } catch (err) {
      res.status(503).json({ status: 'error', error: String(err) });
    }
  });

  // ── API Routes ───────────────────────────────────────────────────────────
  app.use('/api/auth', authRouter);
  app.use('/api/docs', documentsRouter);
  app.use('/api/docs/:id/history', historyRouter);
  app.use('/api/docs/:id/restore', restoreRouter);
  app.use('/api/invites', invitesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/dashboard', dashboardRouter);

  // ── 404 + Error handlers ─────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    logger.error({ err }, 'Unhandled HTTP error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
