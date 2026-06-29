/**
 * PostgreSQL connection pool using node-postgres (pg).
 * Exports a singleton pool instance used throughout the server.
 */

import { Pool, PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      min: config.database.poolMin,
      max: config.database.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL pool error');
    });

    pool.on('connect', () => {
      logger.debug('PostgreSQL client connected');
    });
  }
  return pool;
}

/**
 * Runs a function within a transaction.
 * Automatically commits on success, rolls back on any thrown error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs a query with the shared pool (no transaction).
 */
export async function query<T = any>(
  text: string,
  params?: any[],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

/**
 * Gracefully closes the pool. Call on server shutdown.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
}
