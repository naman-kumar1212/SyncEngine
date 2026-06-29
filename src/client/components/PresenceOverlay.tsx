import React from 'react';
import type { UserPresence } from '../../shared/types/presence';

interface PresenceOverlayProps {
  presence: UserPresence[];
  sessionId: string | null;
}

export const PresenceOverlay: React.FC<PresenceOverlayProps> = ({ presence, sessionId }) => {
  // Filter out self
  const activePeers = presence.filter((p) => p.sessionId !== sessionId);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'row-reverse' }}>
        {activePeers.map((user) => (
          <div
            key={user.sessionId}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              backgroundColor: 'var(--bg-darker)',
              border: `2px solid ${user.color || 'var(--accent-cyan)'}`,
              boxShadow: `0 0 8px ${user.color}40`,
              marginLeft: -8,
              position: 'relative',
              cursor: 'pointer',
              transition: 'transform 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title={`${user.displayName} (${user.isTyping ? 'typing...' : 'active'})`}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px) scale(1.1)';
              e.currentTarget.style.zIndex = '10';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'none';
              e.currentTarget.style.zIndex = 'auto';
            }}
          >
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              userSelect: 'none',
            }}>
              {user.displayName.slice(0, 2)}
            </span>
          </div>
        ))}
      </div>
      {activePeers.length > 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
          {activePeers.length} peer{activePeers.length > 1 ? 's' : ''} online
        </span>
      )}
    </div>
  );
};
