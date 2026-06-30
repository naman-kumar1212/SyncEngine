import React, { useState, useEffect } from 'react';

interface ShareModalProps {
  docId: string;
  accessToken: string;
  onClose: () => void;
}

interface Collaborator {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
}

interface PendingInvite {
  id: string;
  invitee_email: string;
  role: string;
}

export const ShareModal: React.FC<ShareModalProps> = ({ docId, accessToken, onClose }) => {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);

  const fetchData = async () => {
    try {
      const [collabRes, inviteRes] = await Promise.all([
        fetch(`/api/docs/${docId}/collaborators`, { headers: { Authorization: `Bearer ${accessToken}` } }),
        fetch(`/api/docs/${docId}/invites`, { headers: { Authorization: `Bearer ${accessToken}` } })
      ]);
      if (collabRes.ok) setCollaborators(await collabRes.json());
      if (inviteRes.ok) setInvites(await inviteRes.json());
    } catch (e) {
      console.error('Failed to fetch share data', e);
    }
  };

  useEffect(() => {
    fetchData();
  }, [docId, accessToken]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus('loading');
    setErrorMsg('');

    try {
      const res = await fetch(`/api/docs/${docId}/invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ email: email.trim(), role }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send invite');
      }

      setStatus('success');
      setEmail('');
      fetchData(); // refresh list
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err: any) {
      setStatus('error');
      setErrorMsg(err.message);
    }
  };

  const removeCollaborator = async (userId: string) => {
    if (!confirm('Are you sure you want to remove this collaborator?')) return;
    try {
      await fetch(`/api/docs/${docId}/collaborators/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      backdropFilter: 'blur(4px)'
    }}>
      <div className="glass-panel" style={{ width: 500, padding: 24, maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: 'var(--text-primary)' }}>Share Document</h2>
          <button 
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 20 }}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleInvite} style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)' }}>Invite via Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="form-input"
              placeholder="user@example.com"
              required
            />
          </div>
          <div style={{ width: 120 }}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)' }}>Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="form-input"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <button type="submit" className="glow-btn" disabled={status === 'loading'} style={{ height: 40, padding: '0 16px' }}>
            {status === 'loading' ? 'Sending...' : 'Invite'}
          </button>
        </form>

        {status === 'error' && (
          <div style={{ color: 'var(--signal-error)', fontSize: 13, marginBottom: 16 }}>{errorMsg}</div>
        )}
        {status === 'success' && (
          <div style={{ color: 'var(--signal-success)', fontSize: 13, marginBottom: 16 }}>Invitation sent successfully!</div>
        )}

        <div style={{ borderTop: '1px solid var(--border-muted)', paddingTop: 16 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>People with access</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {collaborators.map(c => (
              <div key={c.user_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{c.display_name} {c.role === 'owner' ? '(Owner)' : ''}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.email}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{c.role}</span>
                  {c.role !== 'owner' && (
                    <button onClick={() => removeCollaborator(c.user_id)} style={{ background: 'none', border: 'none', color: 'var(--signal-error)', cursor: 'pointer', fontSize: 12 }}>Remove</button>
                  )}
                </div>
              </div>
            ))}

            {invites.map(i => (
              <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: 0.7 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{i.invitee_email}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Pending Invitation</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{i.role}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
