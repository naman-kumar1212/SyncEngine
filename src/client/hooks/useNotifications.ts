import { useEffect, useRef, useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';

const CLIENT_ID_KEY = 'sync-engine:client-id';

function getOrCreateClientId(): string {
  const stored = localStorage.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const id = uuidv4();
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  message: string;
  read_at: string | null;
  metadata: {
    title?: string;
    link?: string;
  };
  created_at: string;
}

export function useNotifications(
  accessToken: string,
  wsUrl = `ws://${window.location.host}/ws`,
) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const clientId = useRef(getOrCreateClientId());

  const fetchHistory = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await fetch('/api/dashboard', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        // Assuming dashboard endpoint returns notifications, or we need a new endpoint
        // Wait, dashboard.ts returns notifications?
      }
    } catch (e) {
      console.error('Failed to fetch notifications', e);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;

    let ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send JOIN without docId for global notifications
      ws.send(
        JSON.stringify({
          type: 'JOIN',
          token: accessToken,
          lastSeq: 0,
          clientId: clientId.current,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'NOTIFICATION_CREATED') {
          setNotifications((prev) => [msg.notification, ...prev]);
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message in useNotifications', e);
      }
    };

    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, [accessToken, wsUrl]);

  return { notifications, setNotifications };
}
