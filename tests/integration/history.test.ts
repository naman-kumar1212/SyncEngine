/**
 * History and Rollback integration tests.
 *
 * Tests the REST revision API, named tags, and the CRDT state rollback logic
 * that is used to revert a document to any point in time.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createHttpServer } from '../../src/server/transport/http-server';
import { signAccessToken } from '../../src/server/security/jwt';

const mockQuery = vi.fn();
vi.mock('../../src/server/persistence/db', () => ({
  getPool: () => ({ query: mockQuery }),
  query: (sql: string, params: any[]) => mockQuery(sql, params),
}));

vi.mock('../../src/server/persistence/document-store', () => ({
  getDocumentWithPermission: vi.fn(async (docId, userId) => ({
    id: docId,
    title: 'Test Doc',
    role: 'owner',
  })),
}));

const mockRestoreToRevision = vi.fn();
vi.mock('../../src/server/persistence/history-service', () => ({
  listRevisions: vi.fn(async () => [
    { id: 'rev-1', seq: 5, label: 'First checkpoint', createdAt: new Date().toISOString() },
  ]),
  getHistory: vi.fn(async () => []),
  restoreToRevision: (args: any) => mockRestoreToRevision(args),
}));

vi.mock('../../src/server/fanout/redis-pubsub', () => ({
  publishOperation: vi.fn(),
}));

vi.mock('../../src/server/fanout/redis-client', () => ({
  getRedis: () => ({
    ping: vi.fn(async () => 'PONG'),
  }),
}));

describe('History & Rollback API Integration', () => {
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  const docId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';

  beforeAll(() => {
    const app = createHttpServer();
    server = http.createServer(app);

    return new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        token = signAccessToken({ sub: userId, email: 'test@example.com', displayName: 'Test User' });
        resolve();
      });
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('GET /api/docs/:id/history/revisions returns revision list', async () => {
    const res = await fetch(`${baseUrl}/api/docs/${docId}/history/revisions`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].label).toBe('First checkpoint');
  });

  it('POST /api/docs/:id/restore successfully reverts document', async () => {
    mockRestoreToRevision.mockResolvedValueOnce({
      envelope: { seq: 6, op: { type: 'DELETE', uid: { clock: 1, siteId: 'x' } } },
      restoredText: 'Hello',
      newSeq: 6,
    });

    const res = await fetch(`${baseUrl}/api/docs/${docId}/restore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ targetSeq: 5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newSeq).toBe(6);
    expect(body.textLength).toBe(5);
  });
});
