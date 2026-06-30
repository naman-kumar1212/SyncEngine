import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { Editor } from './components/Editor';
import { Dashboard } from './components/Dashboard';

function parseJwt(token: string) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      window.atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function App() {
  const [token, setToken] = useState<string>(localStorage.getItem('access_token') ?? '');
  const [currentDocId, setCurrentDocId] = useState<string | null>(
    new URLSearchParams(window.location.search).get('doc')
  );
  const [docDetails, setDocDetails] = useState<{ title: string; ownerName: string } | null>(null);
  
  // Auth Form State
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [color, setColor] = useState('#00f5ff');
  const [authError, setAuthError] = useState('');

  const user = token ? parseJwt(token) : null;

  // Load specific document details if currentDocId is set
  useEffect(() => {
    if (token && currentDocId) {
      fetch(`/api/docs/${currentDocId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => {
          if (!r.ok) throw new Error('Not found');
          return r.json();
        })
        .then((doc) => {
          setDocDetails({ title: doc.title, ownerName: doc.ownerName || 'Unknown' });
        })
        .catch(() => {
          // Reset document selection on error
          setCurrentDocId(null);
          window.history.pushState({}, '', window.location.pathname);
        });
    }
  }, [token, currentDocId]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const url = isRegister ? '/api/auth/register' : '/api/auth/login';
    const body = isRegister 
      ? { email, password, displayName, color }
      : { email, password };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      if (isRegister) {
        // Automatically switch to login on success
        setIsRegister(false);
        setAuthError('Registration successful! Please login.');
      } else {
        localStorage.setItem('access_token', data.accessToken);
        setToken(data.accessToken);
      }
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const selectDocument = (id: string) => {
    setCurrentDocId(id);
    const newUrl = `${window.location.pathname}?doc=${id}`;
    window.history.pushState({ docId: id }, '', newUrl);
  };

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    setToken('');
    setCurrentDocId(null);
    window.history.pushState({}, '', window.location.pathname);
  };

  const backToDashboard = () => {
    setCurrentDocId(null);
    setDocDetails(null);
    window.history.pushState({}, '', window.location.pathname);
  };

  // ── 1. RENDER AUTH GATE ───────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="auth-container">
        <div className="auth-card glass-panel">
          <div className="auth-header">
            <h1 className="auth-logo gradient-text">SyncEngine</h1>
            <p className="auth-subtitle">
              {isRegister ? 'Create an account to start collaborating' : 'Log in to start editing in real-time'}
            </p>
          </div>

          <form onSubmit={handleAuth}>
            {isRegister && (
              <>
                <div className="form-group">
                  <label className="form-label">Display Name</label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="form-input"
                    placeholder="Jane Doe"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Cursor Color</label>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      style={{ border: 'none', background: 'none', width: 44, height: 40, cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: 13, color: '#8c96a8', fontFamily: 'monospace' }}>{color}</span>
                  </div>
                </div>
              </>
            )}

            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="form-input"
                placeholder="jane@example.com"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="form-input"
                placeholder="••••••••"
              />
            </div>

            {authError && (
              <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 20, textAlign: 'center', fontWeight: 500 }}>
                {authError}
              </p>
            )}

            <button type="submit" className="glow-btn" style={{ width: '100%' }}>
              {isRegister ? 'Register' : 'Log In'}
            </button>
          </form>

          <p className="auth-toggle">
            {isRegister ? 'Already have an account?' : "Don't have an account?"}
            <span onClick={() => { setIsRegister(!isRegister); setAuthError(''); }}>
              {isRegister ? 'Log In' : 'Sign Up'}
            </span>
          </p>
        </div>
      </div>
    );
  }

  // ── 2. RENDER COLLABORATIVE WORKSPACE ────────────────────────────────────
  if (currentDocId && docDetails) {
    return (
      <div style={{ backgroundColor: 'var(--bg-darker)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid var(--border-muted)', backgroundColor: 'var(--bg-dark)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button onClick={backToDashboard} className="outline-btn" style={{ padding: '8px 16px', fontSize: 12 }}>
              ← Dashboard
            </button>
            <div>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block' }}>Collaborative Workspace</span>
              <strong style={{ fontSize: 16, color: 'var(--text-primary)' }}>{docDetails.title}</strong>
            </div>
          </div>
          <div className="user-tag">
            <span className="avatar-dot" style={{ color: user?.color || '#00f5ff' }} />
            <span>{user?.displayName || 'Editor'}</span>
            <button onClick={handleLogout} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600, marginLeft: 8 }}>
              Logout
            </button>
          </div>
        </div>
        <Editor
          docId={currentDocId}
          accessToken={token}
          title={docDetails.title}
          ownerName={docDetails.ownerName}
        />
      </div>
    );
  }

  // ── 3. RENDER DASHBOARD ──────────────────────────────────────────────────
  return (
    <Dashboard
      token={token}
      user={user}
      onLogout={handleLogout}
      onSelectDocument={selectDocument}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
