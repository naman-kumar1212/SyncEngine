/**
 * Session manager — tracks all active WebSocket connections per document.
 *
 * Design:
 *   - `sessions`: Map<sessionId, ClientSession> — all active sessions on this worker
 *   - `docSessions`: Map<docId, Set<sessionId>> — fast lookup of sessions per document
 *
 * Thread-safety: Node.js is single-threaded; no locking needed.
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../logger';

export interface ClientSession {
  readonly id: string;          // Session UUID (server-generated)
  readonly userId: string;
  readonly docId?: string;
  readonly siteId: string;      // UUID used by this client for RGA UID generation
  readonly displayName: string;
  readonly color: string;
  readonly socket: WebSocket;
  readonly connectedAt: number;  // Unix ms
  sendQueue: number;             // Count of messages queued/in-flight (backpressure)
  lastSeq: number;               // Last server seq acknowledged by this client
  lastActivity: number;          // Unix ms (for heartbeat timeout detection)
  isAlive: boolean;              // For heartbeat ping/pong tracking
}

// All active sessions keyed by session ID
const sessions: Map<string, ClientSession> = new Map();
// docId → Set of session IDs for fast broadcast lookup
const docSessions: Map<string, Set<string>> = new Map();
// userId → Set of session IDs for user-targeted messages (e.g. notifications)
const userSessions: Map<string, Set<string>> = new Map();

/**
 * Registers a new session when a client successfully JOINs.
 */
export function registerSession(
  socket: WebSocket,
  params: {
    userId: string;
    docId?: string;
    siteId: string;
    displayName: string;
    color: string;
    lastSeq: number;
  },
): ClientSession {
  const session: ClientSession = {
    ...params,
    id: uuidv4(),
    socket,
    connectedAt: Date.now(),
    sendQueue: 0,
    lastActivity: Date.now(),
    isAlive: true,
  };

  sessions.set(session.id, session);

  if (session.docId) {
    if (!docSessions.has(session.docId)) {
      docSessions.set(session.docId, new Set());
    }
    docSessions.get(session.docId)!.add(session.id);
  }

  if (!userSessions.has(session.userId)) {
    userSessions.set(session.userId, new Set());
  }
  userSessions.get(session.userId)!.add(session.id);

  logger.info({ sessionId: session.id, userId: session.userId, docId: session.docId }, 'Session registered');
  return session;
}

/**
 * Removes a session on disconnect.
 */
export function removeSession(sessionId: string): ClientSession | undefined {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    if (session.docId) {
      docSessions.get(session.docId)?.delete(sessionId);
      if (docSessions.get(session.docId)?.size === 0) {
        docSessions.delete(session.docId);
      }
    }
    userSessions.get(session.userId)?.delete(sessionId);
    if (userSessions.get(session.userId)?.size === 0) {
      userSessions.delete(session.userId);
    }
    logger.info({ sessionId, userId: session.userId, docId: session.docId }, 'Session removed');
  }
  return session;
}

/**
 * Returns a session by ID.
 */
export function getSession(sessionId: string): ClientSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Returns all sessions for a document on THIS worker.
 */
export function getDocumentSessions(docId: string): ClientSession[] {
  const ids = docSessions.get(docId);
  if (!ids) return [];
  return [...ids]
    .map((id) => sessions.get(id))
    .filter((s): s is ClientSession => s !== undefined);
}

/**
 * Sends a message to a specific session.
 * Implements backpressure: if the send queue is full, the client is disconnected.
 *
 * @returns true if the message was sent (or queued), false if the client was dropped
 */
export function sendToSession(session: ClientSession, data: unknown): boolean {
  if (session.socket.readyState !== WebSocket.OPEN) return false;

  if (session.sendQueue >= config.ws.sendQueueMax) {
    logger.warn(
      { sessionId: session.id, userId: session.userId },
      'Slow consumer detected — disconnecting',
    );
    session.socket.close(4009, 'Slow consumer');
    return false;
  }

  const payload = JSON.stringify(data);
  session.sendQueue++;
  session.socket.send(payload, (err) => {
    session.sendQueue--;
    if (err) {
      logger.warn({ err, sessionId: session.id }, 'WebSocket send error');
    }
  });

  return true;
}

/**
 * Broadcasts a message to all sessions in a document EXCEPT the originator.
 */
export function broadcastToDocument(
  docId: string,
  data: unknown,
  excludeSessionId?: string,
): void {
  const docSessionList = getDocumentSessions(docId);
  for (const session of docSessionList) {
    if (session.id === excludeSessionId) continue;
    sendToSession(session, data);
  }
}

/**
 * Returns all sessions for a specific user on THIS worker.
 */
export function getSessionsForUser(userId: string): ClientSession[] {
  const ids = userSessions.get(userId);
  if (!ids) return [];
  return [...ids]
    .map((id) => sessions.get(id))
    .filter((s): s is ClientSession => s !== undefined);
}

/**
 * Broadcasts a message to all active sessions for a specific user.
 */
export function broadcastToUser(userId: string, data: unknown): void {
  const sessionsList = getSessionsForUser(userId);
  for (const session of sessionsList) {
    sendToSession(session, data);
  }
}

/**
 * Returns all session IDs (for monitoring/metrics).
 */
export function getStats() {
  return {
    totalSessions: sessions.size,
    documentsActive: docSessions.size,
    sessionsByDoc: Object.fromEntries(
      [...docSessions.entries()].map(([docId, ids]) => [docId, ids.size]),
    ),
  };
}
