/**
 * WebSocket server — manages the full lifecycle of WebSocket connections.
 *
 * Connection lifecycle:
 *   1. HTTP UPGRADE → WebSocket established
 *   2. Client sends JOIN { docId, token, lastSeq, clientId }
 *   3. Server verifies JWT, loads document, sends JOIN_ACK
 *   4. Client sends OPERATION messages → server processes + broadcasts
 *   5. Client sends PRESENCE messages → server broadcasts to peers
 *   6. Heartbeat PING/PONG keeps connection alive
 *   7. Disconnect → cleanup session + presence
 *
 * Multi-worker fan-out:
 *   Operations received on this worker are published to Redis.
 *   The Redis message handler (redis-pubsub.ts) broadcasts to local sessions.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import {
  registerSession,
  removeSession,
  getSession as getSessionById,
  sendToSession,
  broadcastToDocument,
  type ClientSession,
} from './session-manager';
import { verifyAccessToken } from '../security/jwt';
import {
  ClientMessageSchema,
  JoinMessageSchema,
  OperationMessageSchema,
  PresenceMessageSchema,
  PingMessageSchema,
} from '../security/input-sanitizer';
import { handleOperation } from '../sync/operation-handler';
import { getOrLoadDocument } from '../sync/document-cache';
import { getMissedOperations, shouldForceFullReload } from '../sync/offline-merger';
import {
  updatePresence,
  removePresence,
  getAllPresence,
  buildInitialPresence,
  refreshPresenceTTL,
} from '../sync/presence-manager';
import {
  publishOperation,
  subscribeToDocument,
  unsubscribeFromDocument,
  onUserLeft,
  publishPresence,
  publishUserLeft,
  subscribeToUser,
  unsubscribeFromUser,
} from '../fanout/redis-pubsub';
import { query } from '../persistence/db';
import { config } from '../config';
import { logger } from '../logger';
import type { OperationEnvelope } from '../../shared/types/operation';
import type { UserPresence } from '../../shared/types/presence';
import type {
  JoinAckMessage,
  OpAckMessage,
  BroadcastMessage,
  PresenceBroadcast,
  ErrorMessage,
  UserLeftMessage,
  PongMessage,
} from '../../shared/types/protocol';

// Map from WebSocket instance to session ID (for disconnect cleanup)
const socketToSession: WeakMap<WebSocket, string> = new WeakMap();

/** Track unauthenticated connections to prevent slow-loris WebSocket exhaustion */
let pendingAuthCount = 0;
const MAX_PENDING_AUTH = 100;

export function createWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.ws.maxPayloadBytes,
  });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    // Throttle unauthenticated connections to prevent slow-loris exhaustion
    if (pendingAuthCount >= MAX_PENDING_AUTH) {
      socket.close(4029, 'Too many pending auth connections');
      return;
    }

    pendingAuthCount++;
    logger.debug({ ip: req.socket.remoteAddress, pending: pendingAuthCount }, 'WebSocket connected (awaiting JOIN)');

    // Timeout: disconnect if client doesn't JOIN within 10 seconds
    const joinTimeout = setTimeout(() => {
      if (!socketToSession.has(socket)) {
        pendingAuthCount--;
        socket.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    socket.on('message', async (rawData: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString('utf8'));
      } catch {
        sendError(socket, 'INVALID_OPERATION', 'Invalid JSON');
        return;
      }

      const session = socketToSession.has(socket)
        ? getSession(socket)
        : null;

      // First message must be JOIN
      if (!session) {
        clearTimeout(joinTimeout);
        pendingAuthCount--;
        await handleJoin(socket, parsed);
        return;
      }

      // Subsequent messages
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendError(socket, 'INVALID_OPERATION', result.error.message);
        return;
      }

      const msg = result.data;
      session.lastActivity = Date.now();

      // Priority Queuing: Push to session's message queue and process
      if (!session.messageQueue) {
        session.messageQueue = [];
        session.isProcessing = false;
      }

      // Determine priority: 0 is highest (operations), 1 is lower (presence, pings)
      const priority = msg.type === 'OPERATION' ? 0 : 1;

      // Insert into queue maintaining priority order
      const queue = session.messageQueue as Array<{ priority: number, msg: any }>;
      let inserted = false;
      for (let i = 0; i < queue.length; i++) {
        if (priority < queue[i].priority) {
          queue.splice(i, 0, { priority, msg });
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        queue.push({ priority, msg });
      }

      // Process queue if not already processing
      if (!session.isProcessing) {
        session.isProcessing = true;
        // Run in background without awaiting to free the event loop
        (async () => {
          while (queue.length > 0) {
            const { msg: nextMsg } = queue.shift()!;
            try {
              switch (nextMsg.type) {
                case 'OPERATION':
                  await handleClientOperation(session, nextMsg);
                  break;
                case 'PRESENCE':
                  await handleClientPresence(session, nextMsg);
                  break;
                case 'PING':
                  sendToSession(session, {
                    type: 'PONG',
                    timestamp: nextMsg.timestamp,
                    serverTime: Date.now(),
                  } satisfies PongMessage);
                  session.isAlive = true;
                  break;
              }
            } catch (err) {
              logger.error({ err }, 'Error processing queued message');
            }
          }
          session.isProcessing = false;
        })();
      }
    });

    socket.on('pong', () => {
      const session = getSession(socket);
      if (session) session.isAlive = true;
    });

    socket.on('close', async (code, reason) => {
      clearTimeout(joinTimeout);
      const session = getSession(socket);
      if (session) {
        logger.info({ sessionId: session.id, code }, 'Client disconnected');
        await handleDisconnect(session);
      }
    });

    socket.on('error', (err) => {
      logger.warn({ err }, 'WebSocket socket error');
    });
  });

  // Heartbeat loop: ping all clients every HEARTBEAT_INTERVAL_MS
  // Clients that don't respond within HEARTBEAT_TIMEOUT_MS are terminated
  startHeartbeat(wss);

  logger.info('WebSocket server initialized at /ws');
  return wss;
}

// ─── JOIN Handler ──────────────────────────────────────────────────────────────

async function handleJoin(socket: WebSocket, raw: unknown): Promise<void> {
  const result = JoinMessageSchema.safeParse(raw);
  if (!result.success) {
    sendError(socket, 'INVALID_OPERATION', 'Invalid JOIN message');
    socket.close(4001, 'Invalid JOIN');
    return;
  }

  const msg = result.data;

  // ── Auth ──
  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(msg.token);
  } catch {
    sendError(socket, 'AUTH_FAILED', 'Invalid or expired token');
    socket.close(4001, 'Auth failed');
    return;
  }

  // ── Permission check ──
  let display_name = '';
  let color = '';

  if (msg.docId) {
    const perms = await query<{ role: string; display_name: string; color: string }>(
      `SELECT dp.role, u.display_name, u.color
         FROM document_permissions dp
         JOIN users u ON u.id = dp.user_id
        WHERE dp.doc_id = $1 AND dp.user_id = $2`,
      [msg.docId, payload.sub],
    );

    if (perms.length === 0) {
      sendError(socket, 'PERMISSION_DENIED', 'No access to this document');
      socket.close(4003, 'Permission denied');
      return;
    }
    display_name = perms[0].display_name;
    color = perms[0].color;
  } else {
    const users = await query<{ display_name: string; color: string }>(
      `SELECT display_name, color FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (users.length === 0) {
      sendError(socket, 'AUTH_FAILED', 'User not found');
      socket.close(4001, 'Auth failed');
      return;
    }
    display_name = users[0].display_name;
    color = users[0].color;
  }

  // ── Load document ──
  let cached = { lastSeq: 0, doc: { serialize: () => [] } };
  if (msg.docId) {
    try {
      cached = await getOrLoadDocument(msg.docId) as any;
    } catch (err) {
      sendError(socket, 'DOCUMENT_NOT_FOUND', 'Document not found');
      socket.close(4004, 'Document not found');
      return;
    }
  }

  // ── Compute missed ops for reconnect ──
  let missedOps: OperationEnvelope[] = [];
  let forceFullLoad = false;

  if (msg.docId && msg.lastSeq > 0) {
    missedOps = await getMissedOperations(msg.docId, msg.lastSeq);
    forceFullLoad = shouldForceFullReload(missedOps);
    if (forceFullLoad) missedOps = []; // client will use snapshot
  }

  // ── Assign siteId ──
  const siteId = msg.clientId || 'global-client'; // Client's persistent UUID is used as siteId

  // ── Register session ──
  const session = registerSession(socket, {
    userId: payload.sub,
    docId: msg.docId,
    siteId,
    displayName: display_name,
    color,
    lastSeq: cached.lastSeq,
  });

  socketToSession.set(socket, session.id);

  // ── Presence ──
  let allPresence: UserPresence[] = [];
  if (msg.docId) {
    const presence = buildInitialPresence({
      sessionId: session.id,
      userId: session.userId,
      displayName: session.displayName,
      color: session.color,
    });
    await updatePresence(msg.docId, presence);
    allPresence = await getAllPresence(msg.docId);

    // ── Subscribe this document on this worker ──
    subscribeToDocument(
      msg.docId,
      (envelope) => handleRedisOperation(msg.docId!, envelope),
      (p) => handleRedisPresence(msg.docId!, p),
    );
  }

  // ── Subscribe this user on this worker for notifications ──
  subscribeToUser(session.userId, (notification) => {
    sendToSession(session, {
      type: 'NOTIFICATION_CREATED',
      notification,
    });
  });

  // ── Send JOIN_ACK ──
  const ack: JoinAckMessage = {
    type: 'JOIN_ACK',
    sessionId: session.id,
    siteId,
    snapshot: {
      seq: cached.lastSeq,
      nodes: (msg.docId && (forceFullLoad || msg.lastSeq === 0)) ? cached.doc.serialize() : [],
    },
    missedOps: forceFullLoad ? [] : missedOps,
    presence: allPresence,
  };

  sendToSession(session, ack);

  // ── Persist session ──
  await query(
    `INSERT INTO sessions (id, user_id, doc_id, site_id, last_seq) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET last_seq = $5`,
    [session.id, session.userId, msg.docId, siteId, cached.lastSeq],
  ).catch(() => { }); // non-critical

  logger.info(
    { sessionId: session.id, docId: msg.docId, lastSeq: msg.lastSeq, missedOps: missedOps.length },
    'Client joined',
  );
}

// ─── OPERATION Handler ─────────────────────────────────────────────────────────

async function handleClientOperation(
  session: ClientSession,
  msg: ReturnType<typeof OperationMessageSchema.parse>,
): Promise<void> {
  // Check write permission
  if (session.role === 'viewer') {
    sendToSession(session, {
      type: 'ERROR',
      code: 'PERMISSION_DENIED',
      message: 'Viewer role cannot edit',
    } satisfies ErrorMessage);
    return;
  }

  const result = await handleOperation(session, msg);

  if (result.success && result.envelope) {
    // ACK to originating client
    sendToSession(session, {
      type: 'OP_ACK',
      clientSeq: msg.clientSeq,
      serverSeq: result.envelope.seq,
      timestamp: result.envelope.timestamp,
    } satisfies OpAckMessage);
  } else {
    sendToSession(session, {
      type: 'ERROR',
      code: result.error!.code as any,
      message: result.error!.message,
      clientSeq: msg.clientSeq,
    } satisfies ErrorMessage);
  }
}

// ─── PRESENCE Handler ─────────────────────────────────────────────────────────

const typingTimers = new Map<string, NodeJS.Timeout>();

async function handleClientPresence(
  session: ClientSession,
  msg: ReturnType<typeof PresenceMessageSchema.parse>,
): Promise<void> {
  const presence: UserPresence = {
    sessionId: session.id,
    userId: session.userId,
    displayName: session.displayName,
    color: session.color,
    cursor: msg.update.cursor,
    isTyping: msg.update.isTyping,
    lastSeen: new Date().toISOString(),
  };

  await updatePresence(msg.docId, presence);
  // Publish to Redis so other workers can fan out to their locally connected clients
  await publishPresence(msg.docId, presence);

  // Auto-stop typing indicator after 3 seconds of inactivity
  const timerKey = `${msg.docId}:${session.id}`;
  if (msg.update.isTyping) {
    if (typingTimers.has(timerKey)) clearTimeout(typingTimers.get(timerKey));
    typingTimers.set(
      timerKey,
      setTimeout(async () => {
        typingTimers.delete(timerKey);
        // Ensure session is still active
        if (!getSessionById(session.id)) return;
        const updatedPresence = {
          ...presence,
          isTyping: false,
          lastSeen: new Date().toISOString(),
        };
        await updatePresence(msg.docId, updatedPresence).catch(() => { });
        await publishPresence(msg.docId, updatedPresence).catch(() => { });
      }, 3000),
    );
  } else {
    if (typingTimers.has(timerKey)) {
      clearTimeout(typingTimers.get(timerKey));
      typingTimers.delete(timerKey);
    }
  }
}

// ─── Redis Fan-out Handlers ────────────────────────────────────────────────────

function handleRedisOperation(docId: string, envelope: OperationEnvelope): void {
  const broadcast: BroadcastMessage = { type: 'BROADCAST', envelope };
  broadcastToDocument(docId, broadcast);
}

const presenceBatches = new Map<string, Map<string, UserPresence>>();
const presenceTimers = new Map<string, NodeJS.Timeout>();

function handleRedisPresence(docId: string, presence: UserPresence): void {
  if (!presenceBatches.has(docId)) {
    presenceBatches.set(docId, new Map());
  }
  const batch = presenceBatches.get(docId)!;
  // Overwrite older presence for the same session
  batch.set(presence.sessionId, presence);

  if (!presenceTimers.has(docId)) {
    const timer = setTimeout(() => {
      const currentBatch = presenceBatches.get(docId);
      presenceBatches.delete(docId);
      presenceTimers.delete(docId);

      if (currentBatch && currentBatch.size > 0) {
        // Send a separate message for each updated presence, or extend protocol for batching.
        // For now, iterate and send. The WebSocket message queue handles network pacing.
        for (const p of currentBatch.values()) {
          const broadcast: PresenceBroadcast = { type: 'PRESENCE_UPDATE', presence: p };
          broadcastToDocument(docId, broadcast);
        }
      }
    }, 50); // 50ms debounce
    presenceTimers.set(docId, timer);
  }
}

// ─── Disconnect Handler ────────────────────────────────────────────────────────

async function handleDisconnect(session: ClientSession): Promise<void> {
  removeSession(session.id);

  if (session.docId) {
    await removePresence(session.docId, session.id, session.userId);

    // Broadcast USER_LEFT locally AND publish to Redis for cross-worker fan-out
    broadcastToDocument(session.docId, {
      type: 'USER_LEFT',
      sessionId: session.id,
      userId: session.userId,
    } satisfies UserLeftMessage);
    await Promise.resolve(
      publishUserLeft(session.docId, session.id, session.userId),
    ).catch((err) =>
      logger.warn({ err, sessionId: session.id }, 'Failed to publish USER_LEFT to Redis'),
    );

    unsubscribeFromDocument(
      session.docId,
      (envelope) => handleRedisOperation(session.docId!, envelope),
      (p) => handleRedisPresence(session.docId!, p),
    );
  }

  unsubscribeFromUser(session.userId, () => { });

  await query(
    `UPDATE sessions SET disconnected_at = now() WHERE id = $1`,
    [session.id],
  ).catch(() => { });
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat(wss: WebSocketServer): void {
  const interval = setInterval(() => {
    wss.clients.forEach((socket) => {
      const session = getSession(socket);
      if (!session) return;

      const timeSinceActivity = Date.now() - session.lastActivity;
      if (!session.isAlive || timeSinceActivity > config.ws.heartbeatTimeoutMs * 2) {
        logger.warn({ sessionId: session.id }, 'Heartbeat timeout — terminating connection');
        socket.terminate();
        return;
      }

      session.isAlive = false;
      socket.ping();
    });
  }, config.ws.heartbeatIntervalMs);

  wss.on('close', () => clearInterval(interval));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendError(socket: WebSocket, code: string, message: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'ERROR', code, message }));
  }
}

function getSession(socket: WebSocket): ClientSession | undefined {
  const sessionId = socketToSession.get(socket);
  if (!sessionId) return undefined;
  return getSessionById(sessionId);
}

// Extend ClientSession type to include role (loaded from DB during JOIN)
declare module './session-manager' {
  interface ClientSession {
    role?: string;
    messageQueue?: Array<{ priority: number, msg: any }>;
    isProcessing?: boolean;
  }
}
