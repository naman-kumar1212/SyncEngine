import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleOperation } from '../../../src/server/sync/operation-handler';
import type { ClientSession } from '../../../src/server/transport/session-manager';

// Mock dependencies
const mockAppendOperation = vi.fn();
const mockPublishOperation = vi.fn();
const mockIsReplay = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockMaybeTakeSnapshot = vi.fn();
const mockGetOrLoadDocument = vi.fn();
const mockUpdateCachedDocument = vi.fn();

vi.mock('../../../src/server/sync/document-cache', () => ({
  getOrLoadDocument: (docId: string) => mockGetOrLoadDocument(docId),
  updateCachedDocument: (docId: any, mutator: any) => mockUpdateCachedDocument(docId, mutator),
}));

vi.mock('../../../src/server/persistence/operation-store', () => ({
  appendOperation: (args: any) => mockAppendOperation(args),
}));

vi.mock('../../../src/server/fanout/redis-pubsub', () => ({
  publishOperation: (args: any) => mockPublishOperation(args),
}));

vi.mock('../../../src/server/security/replay-guard', () => ({
  isReplay: (docId: string, nonce: string) => mockIsReplay(docId, nonce),
}));

vi.mock('../../../src/server/sync/rate-limiter', () => ({
  checkRateLimit: (userId: string) => mockCheckRateLimit(userId),
}));

vi.mock('../../../src/server/jobs/snapshot-compactor', () => ({
  maybeTakeSnapshot: (docId: string) => mockMaybeTakeSnapshot(docId),
}));



describe('handleOperation', () => {
  let session: ClientSession;
  const msg = {
    type: 'OPERATION' as const,
    docId: 'doc-1',
    clientSeq: 1,
    op: {
      type: 'INSERT' as const,
      uid: { clock: 1, siteId: 'site-1' },
      after: null,
      value: 'a',
    },
    vectorClock: {},
    nonce: 'nonce-1',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    session = {
      id: 'session-1',
      userId: 'user-1',
      docId: 'doc-1',
      siteId: 'site-1',
      displayName: 'User 1',
      color: '#ff0000',
      socket: {} as any,
      connectedAt: Date.now(),
      sendQueue: 0,
      lastSeq: 0,
      lastActivity: Date.now(),
      isAlive: true,
    };
    mockIsReplay.mockResolvedValue(false);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockAppendOperation.mockResolvedValue({ seq: 1, timestamp: new Date().toISOString() });
    mockPublishOperation.mockResolvedValue(undefined);
    mockMaybeTakeSnapshot.mockResolvedValue(undefined);
    mockGetOrLoadDocument.mockResolvedValue({
      doc: { applyOperation: () => true },
      lastSeq: 0,
      opsSinceSnapshot: 0,
      loadedAt: Date.now(),
    });
    mockUpdateCachedDocument.mockImplementation((docId, mutator) => {
      const entry = { lastSeq: 0, opsSinceSnapshot: 0, loadedAt: Date.now() };
      mutator(entry);
    });
  });

  it('successfully processes a valid operation', async () => {
    const result = await handleOperation(session, msg);

    expect(result.success).toBe(true);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('user-1');
    expect(mockIsReplay).toHaveBeenCalledWith('doc-1', 'nonce-1');
    expect(mockAppendOperation).toHaveBeenCalled();
    expect(mockPublishOperation).toHaveBeenCalled();
  });

  it('rejects operation if rate limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });

    const result = await handleOperation(session, msg);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(mockAppendOperation).not.toHaveBeenCalled();
  });

  it('rejects operation if replay detected', async () => {
    mockIsReplay.mockResolvedValue(true);

    const result = await handleOperation(session, msg);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPLAY_DETECTED');
    expect(mockAppendOperation).not.toHaveBeenCalled();
  });

  it('rejects operation if siteId does not match session siteId', async () => {
    const maliciousMsg = {
      ...msg,
      op: {
        ...msg.op,
        uid: { clock: 1, siteId: 'other-site' }, // trying to spoof another user
      },
    };

    const result = await handleOperation(session, maliciousMsg);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_OPERATION');
    expect(mockAppendOperation).not.toHaveBeenCalled();
  });
});
