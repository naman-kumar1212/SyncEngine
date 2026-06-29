/**
 * Database migration runner.
 * Applies schema.sql on startup if tables don't exist.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool, closePool } from './db';

async function migrate() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const pool = getPool();

  console.log('Running database migration...');
  await pool.query(schema);
  console.log('Migration complete.');

  await closePool();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

export { migrate };
