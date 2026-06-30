import React, { useState, useEffect } from 'react';
import { useNotifications, Notification } from '../hooks/useNotifications';

interface NotificationCenterProps {
  token: string;
}

export function NotificationCenter({ token }: NotificationCenterProps) {
  const { notifications, setNotifications } = useNotifications(token);
  const [isOpen, setIsOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    if (isOpen && !historyLoaded) {
      fetch('/api/notifications', {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then(r => r.json())
      .then(data => {
        // Merge history with real-time notifications
        setNotifications(prev => {
          const map = new Map(prev.map(n => [n.id, n]));
          data.forEach((n: Notification) => {
            if (!map.has(n.id)) map.set(n.id, n);
          });
          return Array.from(map.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        });
        setHistoryLoaded(true);
      })
      .catch(err => console.error(err));
    }
  }, [isOpen, historyLoaded, token, setNotifications]);

  const unreadCount = notifications.filter(n => !n.read_at).length;

  const markAsRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
    } catch (e) {
      console.error(e);
    }
  };

  const markAllAsRead = async () => {
    try {
      await fetch(`/api/notifications/read-all`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      setNotifications(prev => prev.map(n => ({ ...n, read_at: new Date().toISOString() })));
    } catch (e) {
      console.error(e);
    }
  };

  const handleAction = async (notification: Notification, accept: boolean) => {
    if (notification.type === 'INVITATION' && notification.metadata?.link) {
      const tokenStr = notification.metadata.link.split('/').pop();
      try {
        const url = `/api/invites/${tokenStr}/${accept ? 'accept' : 'reject'}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          markAsRead(notification.id);
          // If accept, maybe navigate to document or refresh dashboard
          if (accept) {
            window.location.reload();
          }
        } else {
          alert('Failed to process invitation');
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      markAsRead(notification.id);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button 
        className="outline-btn" 
        onClick={() => setIsOpen(!isOpen)}
        style={{ position: 'relative', padding: '8px 12px' }}
      >
        🔔
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5,
            background: '#ef4444', color: 'white', borderRadius: '50%',
            width: 18, height: 18, fontSize: 11, display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontWeight: 'bold'
          }}>
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="glass-panel" style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8,
          width: 320, maxHeight: 400, overflowY: 'auto',
          zIndex: 100, padding: 16
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Notifications</h3>
            {unreadCount > 0 && (
              <button onClick={markAllAsRead} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 12 }}>
                Mark all read
              </button>
            )}
          </div>
          
          {notifications.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center' }}>No notifications</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {notifications.map(n => (
                <div key={n.id} style={{
                  padding: 12, borderRadius: 6,
                  background: n.read_at ? 'var(--bg-dark)' : 'var(--bg-lighter)',
                  border: n.read_at ? '1px solid var(--border-muted)' : '1px solid var(--accent-primary)'
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{n.metadata?.title || 'Notification'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{n.message}</div>
                  {n.type === 'INVITATION' && !n.read_at && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="glow-btn" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => handleAction(n, true)}>Accept</button>
                      <button className="outline-btn" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => handleAction(n, false)}>Reject</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
