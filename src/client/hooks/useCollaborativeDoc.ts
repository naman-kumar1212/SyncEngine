/**
 * useCollaborativeDoc — React hook that integrates the CRDT, WebSocket, and offline queue.
 *
 * Responsibilities:
 *   - Manages WebSocket connection (connect, reconnect with exponential backoff)
 *   - Applies local edits optimistically and sends to server
 *   - Applies remote broadcasts to local CRDT
 *   - Handles reconnect: merges missed ops, re-sends queued ops
 *   - Exposes document text, connection state, and presence to the component
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { UID } from '../../shared/types/operation';
import { ClientRGADocument } from '../crdt/client-rga';
import { OfflineQueue } from '../crdt/offline-queue';
import type {
  ClientMessage,
  ServerMessage,
  JoinAckMessage,
  BroadcastMessage,
  PresenceBroadcast,
  UserLeftMessage,
} from '../../shared/types/protocol';
import type { UserPresence } from '../../shared/types/presence';

const CLIENT_ID_KEY = 'sync-engine:client-id';

function getOrCreateClientId(): string {
  const stored = localStorage.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const id = uuidv4();
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseCollaborativeDocResult {
  text: string;
  status: ConnectionStatus;
  presence: UserPresence[];
  sessionId: string | null;
  localInsert: (index: number, char: string) => void;
  localDelete: (index: number) => void;
  localBatchEdit: (before: string, after: string) => void;
  sendCursor: (afterIndex: number | null) => void;
  uidToIndex: (uid: UID) => number | null;
}

export function useCollaborativeDoc(
  docId: string,
  accessToken: string,
  wsUrl = `ws://${window.location.host}/ws`,
): UseCollaborativeDocResult {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [presence, setPresence] = useState<UserPresence[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const docRef = useRef<ClientRGADocument | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<OfflineQueue>(new OfflineQueue(docId));
  const clientSeqRef = useRef(0);
  const lastSeqRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const reconnectAttempts = useRef(0);
  const clientId = useRef(getOrCreateClientId());

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus('connecting');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      // Send JOIN with lastSeq for reconnect recovery
      send({
        type: 'JOIN',
        docId,
        token: accessToken,
        lastSeq: lastSeqRef.current,
        clientId: clientId.current,
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);
        handleServerMessage(msg);
      } catch {
        console.error('Failed to parse server message');
      }
    };

    ws.onclose = (ev) => {
      setStatus('disconnected');
      if (ev.code === 4001 || ev.code === 4003) {
        // Auth or permission error — don't reconnect
        setStatus('error');
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => setStatus('error');
  }, [docId, accessToken, wsUrl, send]);

  const scheduleReconnect = useCallback(() => {
    const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts.current));
    reconnectAttempts.current++;
    reconnectTimer.current = setTimeout(connect, delay);
  }, [connect]);

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'JOIN_ACK': {
        const ack = msg as JoinAckMessage;
        setSessionId(ack.sessionId);

        // Reconstruct local doc from snapshot
        const doc = ClientRGADocument.deserialize(ack.snapshot.nodes, ack.siteId);
        docRef.current = doc;

        // Apply missed ops (from server, for reconnect)
        for (const env of ack.missedOps) {
          doc.applyOperation(env.op);
          lastSeqRef.current = Math.max(lastSeqRef.current, env.seq);
        }

        // Re-send queued offline ops
        const queued = queueRef.current.getAll();
        for (const qOp of queued) {
          send({
            type: 'OPERATION',
            docId,
            clientSeq: qOp.clientSeq,
            op: qOp.op,
            vectorClock: {},
            nonce: qOp.nonce,
          });
        }

        setPresence(ack.presence);
        setText(doc.toText());
        setStatus('connected');
        break;
      }

      case 'OP_ACK': {
        queueRef.current.acknowledge(msg.clientSeq);
        lastSeqRef.current = Math.max(lastSeqRef.current, msg.serverSeq);
        break;
      }

      case 'BROADCAST': {
        const b = msg as BroadcastMessage;
        lastSeqRef.current = Math.max(lastSeqRef.current, b.envelope.seq);
        if (docRef.current) {
          docRef.current.applyOperation(b.envelope.op);
          setText(docRef.current.toText());
        }
        break;
      }

      case 'PRESENCE_UPDATE': {
        const p = msg as PresenceBroadcast;
        setPresence((prev) => {
          const filtered = prev.filter((u) => u.sessionId !== p.presence.sessionId);
          return [...filtered, p.presence];
        });
        break;
      }

      case 'USER_LEFT': {
        const left = msg as UserLeftMessage;
        setPresence((prev) => prev.filter((u) => u.sessionId !== left.sessionId));
        break;
      }

      case 'ERROR':
        console.warn('Server error:', msg.code, msg.message);
        break;
    }
  }, [docId, send]);

  // ── Local edit operations ──────────────────────────────────────────────────

  const localInsert = useCallback((index: number, char: string) => {
    if (!docRef.current) return;
    clientSeqRef.current++;
    const op = docRef.current.localInsert(index, char);
    const nonce = uuidv4();

    queueRef.current.enqueue({
      clientSeq: clientSeqRef.current,
      op,
      nonce,
      timestamp: Date.now(),
      attempts: 1,
    });

    send({
      type: 'OPERATION',
      docId,
      clientSeq: clientSeqRef.current,
      op,
      vectorClock: {},
      nonce,
    });

    setText(docRef.current.toText());
  }, [docId, send]);

  const localDelete = useCallback((index: number) => {
    if (!docRef.current) return;
    clientSeqRef.current++;
    const op = docRef.current.localDelete(index);
    if (!op) return;
    const nonce = uuidv4();

    queueRef.current.enqueue({
      clientSeq: clientSeqRef.current,
      op,
      nonce,
      timestamp: Date.now(),
      attempts: 1,
    });

    send({
      type: 'OPERATION',
      docId,
      clientSeq: clientSeqRef.current,
      op,
      vectorClock: {},
      nonce,
    });

    setText(docRef.current.toText());
  }, [docId, send]);

  const localBatchEdit = useCallback((before: string, after: string) => {
    if (!docRef.current) return;
    const ops = docRef.current.diffToOperations(before, after);
    for (const op of ops) {
      clientSeqRef.current++;
      const nonce = uuidv4();
      queueRef.current.enqueue({ clientSeq: clientSeqRef.current, op, nonce, timestamp: Date.now(), attempts: 1 });
      send({ type: 'OPERATION', docId, clientSeq: clientSeqRef.current, op, vectorClock: {}, nonce });
    }
    setText(docRef.current.toText());
  }, [docId, send]);

  const sendCursor = useCallback((afterIndex: number | null) => {
    const uid = afterIndex !== null && docRef.current
      ? docRef.current.getAfterUID(afterIndex)
      : null;
    send({
      type: 'PRESENCE',
      docId,
      update: {
        sessionId: sessionId ?? '',
        cursor: { afterUid: uid, anchorUid: null },
        isTyping: false,
      },
    });
  }, [docId, send, sessionId]);

  const uidToIndex = useCallback((uid: UID) => {
    return docRef.current?.uidToIndex(uid) ?? null;
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close(1000, 'Component unmounted');
    };
  }, [connect]);

  return { text, status, presence, sessionId, localInsert, localDelete, localBatchEdit, sendCursor, uidToIndex };
}
