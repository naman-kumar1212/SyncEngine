import React, { useState, useEffect } from 'react';
import { NotificationCenter } from './NotificationCenter';

interface DashboardProps {
  token: string;
  user: any;
  onLogout: () => void;
  onSelectDocument: (id: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ token, user, onLogout, onSelectDocument }) => {
  const [activeTab, setActiveTab] = useState<'recent' | 'my-docs' | 'shared' | 'starred' | 'archived'>('recent');
  const [docs, setDocs] = useState<any[]>([]);
  const [starredDocs, setStarredDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  useEffect(() => {
    loadDashboard();
  }, [token]);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dashboard', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401) {
        onLogout();
        return;
      }
      const data = await res.json();
      setDocs(data.recentDocuments || []);
      setStarredDocs(data.starredDocuments || []);
      setUnreadNotifications(data.unreadNotificationsCount || 0);
    } catch (err) {
      console.error('Failed to load dashboard', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      const res = await fetch('/api/docs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: newTitle }),
      });
      if (res.ok) {
        const doc = await res.json();
        setNewTitle('');
        onSelectDocument(doc.id);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const getFilteredDocs = () => {
    switch (activeTab) {
      case 'recent':
      case 'my-docs': // For now just use recent for my-docs since API is limited
        return docs;
      case 'shared':
        return docs.filter(d => d.ownerId !== user?.sub);
      case 'starred':
        return starredDocs;
      case 'archived':
        return []; // Need API support for archived
      default:
        return docs;
    }
  };

  const filteredDocs = getFilteredDocs();

  return (
    <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--bg-darker)' }}>
      {/* Header */}
      <div className="dashboard-header" style={{ borderBottom: '1px solid var(--border-muted)', padding: '20px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--bg-dark)' }}>
        <div>
          <h1 className="gradient-text" style={{ fontSize: 28, fontWeight: 800, letterSpacing: -1, margin: 0 }}>SyncEngine</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>Real-Time Collaborative Document Manager</p>
        </div>
        <div className="user-tag" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <NotificationCenter token={token} />
          <span className="avatar-dot" style={{ color: user?.color || '#00f5ff' }} />
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{user?.displayName || 'User'}</span>
          <button onClick={onLogout} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
            Logout
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <div style={{ width: 250, borderRight: '1px solid var(--border-muted)', padding: '24px 0', backgroundColor: 'var(--bg-dark)' }}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {[
              { id: 'recent', label: '🕒 Recent' },
              { id: 'my-docs', label: '📄 My Documents' },
              { id: 'shared', label: '👥 Shared with Me' },
              { id: 'starred', label: '⭐ Starred' },
              { id: 'archived', label: '📦 Archived' },
            ].map(tab => (
              <li key={tab.id}>
                <button
                  onClick={() => setActiveTab(tab.id as any)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 24px',
                    background: activeTab === tab.id ? 'rgba(0, 245, 255, 0.1)' : 'transparent',
                    border: 'none',
                    borderRight: activeTab === tab.id ? '3px solid #00f5ff' : '3px solid transparent',
                    color: activeTab === tab.id ? '#00f5ff' : 'var(--text-secondary)',
                    fontWeight: activeTab === tab.id ? 600 : 400,
                    cursor: 'pointer',
                    fontSize: 14,
                    transition: 'all 0.2s'
                  }}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Main Content */}
        <div style={{ flex: 1, padding: 40, overflowY: 'auto' }}>
          <div className="glass-panel" style={{ padding: 24, marginBottom: 40 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 16 }}>
              Create New Document
            </h2>
            <form onSubmit={handleCreateDocument} style={{ display: 'flex', gap: 12 }}>
              <input
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="form-input"
                placeholder="e.g. Collaborative Design System spec..."
                style={{ flex: 1 }}
              />
              <button type="submit" className="glow-btn">
                + New Document
              </button>
            </form>
          </div>

          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 24, textTransform: 'capitalize' }}>
            {activeTab.replace('-', ' ')}
          </h2>

          {loading ? (
            <p style={{ color: 'var(--text-secondary)' }}>Loading documents...</p>
          ) : filteredDocs.length === 0 ? (
            <div className="empty-state">
              <h3 className="empty-title">No documents found</h3>
              <p className="empty-text">There are no documents in this category.</p>
            </div>
          ) : (
            <div className="doc-grid">
              {filteredDocs.map((doc) => (
                <div key={doc.id} className="doc-card" onClick={() => onSelectDocument(doc.id)}>
                  <div>
                    <h3 className="doc-title">{doc.title}</h3>
                    <div className="doc-meta">
                      <span>Created: {new Date(doc.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="doc-footer">
                    <span className="doc-badge">{doc.role === 'owner' ? 'Owner' : 'Guest'}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Open →</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
