import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createHttpServer } from '../../src/server/transport/http-server';
import { signAccessToken } from '../../src/server/security/jwt';

// Mock DB queries
const mockQuery = vi.fn((sql: string, params: any[]) => {
  const sqlClean = sql.toLowerCase().replace(/\s+/g, ' ');
  
  if (sqlClean.includes('from documents d join document_permissions')) {
    // getDocumentWithPermission
    return Promise.resolve([{ id: '11111111-1111-1111-1111-111111111111', title: 'Test Doc', owner_id: '22222222-2222-2222-2222-222222222222', role: 'owner', created_at: new Date(), updated_at: new Date(), is_deleted: false }]);
  }
  if (sqlClean.includes('from users where email')) {
    // Check user registration
    return Promise.resolve([{ id: '33333333-3333-3333-3333-333333333333', email: 'friend@example.com' }]);
  }
  if (sqlClean.includes('select count(*) from document_permissions')) {
    // Collab count
    return Promise.resolve([{ count: '1' }]);
  }
  if (sqlClean.includes('select user_id from document_permissions where doc_id') && sqlClean.includes('and user_id')) {
    // Already collab check
    return Promise.resolve([]);
  }
  if (sqlClean.includes('from invitations where doc_id')) {
    // Pending invite check
    return Promise.resolve([]);
  }
  if (sqlClean.includes('insert into invitations')) {
    // Create invite
    return Promise.resolve([{ id: 'inv1', token: 'invite-token', doc_id: '11111111-1111-1111-1111-111111111111', role: 'editor', email: 'friend@example.com' }]);
  }
  if (sqlClean.includes('insert into notifications')) {
    // Create notification
    return Promise.resolve([{ id: 'notif1' }]);
  }
  if (sqlClean.includes('select * from invitations where token')) {
    // getInvitationByToken
    return Promise.resolve([{ token: 'invite-token', doc_id: '11111111-1111-1111-1111-111111111111', role: 'editor', email: 'friend@example.com', expires_at: new Date(Date.now() + 100000).toISOString() }]);
  }
  if (sqlClean.includes('select dp.user_id, dp.role, u.email, u.display_name') && sqlClean.includes('from document_permissions dp')) {
    // getCollaborators
    return Promise.resolve([{ user_id: '22222222-2222-2222-2222-222222222222', display_name: 'Test User', email: 'test@example.com', role: 'owner' }]);
  }
  
  return Promise.resolve([]);
});

vi.mock('../../src/server/persistence/db', () => ({
  getPool: () => ({ query: mockQuery }),
  query: (sql: string, params: any[]) => mockQuery(sql, params),
  withTransaction: async (cb: any) => cb({ query: (sql: string, params: any[]) => mockQuery(sql, params).then((rows: any) => ({ rows })) }),
}));

vi.mock('../../src/server/fanout/redis-pubsub', () => ({
  publishUserNotification: vi.fn().mockResolvedValue(true),
}));

describe('Sharing & Collaboration API', () => {
  let app: any;
  let token: string;
  const docId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';

  beforeAll(() => {
    app = createHttpServer();
    token = signAccessToken(userId, 'test@example.com', 'Test User');
  });

  describe('GET /api/docs/:id/collaborators', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get(`/api/docs/${docId}/collaborators`);
      expect(res.status).toBe(401);
    });

    it('returns collaborators if authorized', async () => {
      // Mocks handled globally now

      const res = await request(app)
        .get(`/api/docs/${docId}/collaborators`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].role).toBe('owner');
    });
  });

  describe('POST /api/docs/:id/invites', () => {
    it('creates an invitation', async () => {
      // Mocks handled globally now

      const res = await request(app)
        .post(`/api/docs/${docId}/invites`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'editor', email: 'friend@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBe('invite-token');
      expect(res.body.role).toBe('editor');
    });
  });

  describe('POST /api/invites/:token/accept', () => {
    it('accepts an invitation', async () => {
      // Mocks handled globally now


      const res = await request(app)
        .post(`/api/invites/invite-token/accept`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.docId).toBe(docId);
    });
  });
});
