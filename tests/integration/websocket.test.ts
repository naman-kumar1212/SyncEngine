/**
 * Live integration tests for WebSocket connectivity, JOIN protocol, and broadcasts.
 *
 * Runs against the actual HTTP/WS server using mocked database services
 * to verify correct WebSocket server behavior in a realistic network setup.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import WebSocket from 'ws';
import { createHttpServer } from '../../src/server/transport/http-server';
import { createWebSocketServer } from '../../src/server/transport/websocket-server';
import { signAccessToken } from '../../src/server/security/jwt';
import { config } from '../../src/server/config';

// Mock DB queries so we don't need Postgres running for these tests
const mockQuery = vi.fn().mockResolvedValue([]);
vi.mock('../../src/server/persistence/db', () => ({
  getPool: () => ({ query: mockQuery }),
  query: (sql: string, params: any[]) => mockQuery(sql, params),
}));

// Mock Redis pub/sub
const mockPublish = vi.fn();
const mockSubscribe = vi.fn();
vi.mock('../../src/server/fanout/redis-pubsub', () => ({
  publishOperation: (env: any) => mockPublish(env),
  publishPresence: vi.fn(),
  publishUserLeft: vi.fn(),
  subscribeToDocument: (docId: string, onOp: any, onPresence: any) => mockSubscribe(docId),
  unsubscribeFromDocument: vi.fn(),
  onUserLeft: vi.fn(() => () => {}),
}));

vi.mock('../../src/server/fanout/redis-client', () => ({
  getRedis: () => ({
    set: vi.fn(),
    del: vi.fn(),
    keys: vi.fn(async () => []),
    expire: vi.fn(),
    ping: vi.fn(async () => 'PONG'),
  }),
}));

describe('WebSocket Integration', () => {
  let server: http.Server;
  let wsUrl: string;
  let token: string;
  const docId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';

  beforeAll(() => {
    const app = createHttpServer();
    server = http.createServer(app);
    createWebSocketServer(server);

    return new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
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

  it('rejects connection without JOIN message (timeout)', () => {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('close', (code, reason) => {
        expect(code).toBe(4001); // Auth timeout
        resolve();
      });
    });
  }, 12000);

  it('successfully joins document with valid JWT', () => {
    // Mock user permission and document existence query
    mockQuery.mockResolvedValueOnce([
      { role: 'editor', display_name: 'Test User', color: '#ff0000' },
    ]);

    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'JOIN',
            docId,
            token,
            lastSeq: 0,
            clientId: '33333333-3333-3333-3333-333333333333',
          }),
        );
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ERROR') {
          console.error('WebSocket Error message:', msg);
        }
        expect(msg.type).toBe('JOIN_ACK');
        expect(msg.siteId).toBe('33333333-3333-3333-3333-333333333333');
        ws.close();
        resolve();
      });
    });
  });

  it('rejects join with invalid token', () => {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'JOIN',
            docId,
            token: 'invalid-token',
            lastSeq: 0,
            clientId: 'client-1',
          }),
        );
      });

      ws.on('close', (code) => {
        expect(code).toBe(4001); // Auth failed
        resolve();
      });
    });
  });
});
