/**
 * Offline merger tests: reconnect recovery simulation.
 */

import { describe, it, expect } from 'vitest';
import { getMissedOperations, shouldForceFullReload } from '../../../src/server/sync/offline-merger';
import type { OperationEnvelope } from '../../../src/shared/types/operation';

// Mock the DB module
const mockOps: OperationEnvelope[] = Array.from({ length: 10 }, (_, i) => ({
  id: `op-${i + 1}`,
  docId: 'doc-test',
  sessionId: 'session-1',
  userId: 'user-1',
  op: { type: 'INSERT' as const, uid: { clock: i + 1, siteId: 'site-a' }, after: i === 0 ? null : { clock: i, siteId: 'site-a' }, value: String.fromCharCode(65 + i) },
  seq: i + 1,
  clientSeq: i + 1,
  timestamp: new Date().toISOString(),
  vectorClock: {},
  nonce: `nonce-${i + 1}`,
}));

import { vi } from 'vitest';
vi.mock('../../../src/server/persistence/operation-store', () => ({
  loadOperationsAfterSeq: vi.fn(async (docId: string, afterSeq: number, limit = 10_000) => {
    return mockOps.filter((op) => op.seq > afterSeq).slice(0, limit);
  }),
}));

describe('Offline merger', () => {
  it('returns empty array for fresh join (lastSeq = 0)', async () => {
    const missed = await getMissedOperations('doc-test', 0);
    expect(missed).toHaveLength(0);
  });

  it('returns ops after lastSeq for reconnecting client', async () => {
    const missed = await getMissedOperations('doc-test', 5);
    expect(missed).toHaveLength(5);
    expect(missed[0].seq).toBe(6);
    expect(missed[4].seq).toBe(10);
  });

  it('returns all ops when lastSeq is 1', async () => {
    const missed = await getMissedOperations('doc-test', 1);
    expect(missed).toHaveLength(9);
  });
});

describe('shouldForceFullReload', () => {
  it('returns false for small op count', () => {
    const ops = Array.from({ length: 100 }, (_, i) => mockOps[0]);
    expect(shouldForceFullReload(ops)).toBe(false);
  });

  it('returns true for more than 5000 ops', () => {
    const ops = Array.from({ length: 5001 }, () => mockOps[0]);
    expect(shouldForceFullReload(ops)).toBe(true);
  });
});
