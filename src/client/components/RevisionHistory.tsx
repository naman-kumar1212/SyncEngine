import React, { useEffect, useState } from 'react';
import type { Revision } from '../../shared/types/document';

interface RevisionHistoryProps {
  docId: string;
  accessToken: string;
  onRestoreSuccess: (newSeq: number) => void;
}

export const RevisionHistory: React.FC<RevisionHistoryProps> = ({
  docId,
  accessToken,
  onRestoreSuccess,
}) => {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    fetchRevisions();
  }, [docId]);

  const fetchRevisions = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/docs/${docId}/history/revisions`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch revisions');
      const data = await res.json();
      setRevisions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (seq: number) => {
    if (!window.confirm(`Are you sure you want to restore the document to sequence #${seq}? This will broadcast a rollback operation to all users.`)) {
      return;
    }

    setRestoring(seq);
    try {
      const res = await fetch(`/api/docs/${docId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ targetSeq: seq }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Restore failed');
      }

      const result = await res.json();
      onRestoreSuccess(result.newSeq);
      alert('Document successfully restored!');
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setRestoring(null);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 20 }}>Loading revisions...</div>;
  if (error) return <div style={{ color: 'var(--signal-error)', fontSize: 13, padding: 20 }}>Error: {error}</div>;

  return (
    <div className="glass-panel" style={{ padding: 20, maxHeight: 400, overflowY: 'auto' }}>
      <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20 }}>
        <svg style={{ width: 16, height: 16, color: 'var(--accent-cyan)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Revision Milestones
      </h3>
      {revisions.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>No milestones tagged yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', position: 'relative', borderLeft: '1px solid var(--border-muted)', paddingLeft: 20, marginLeft: 8 }}>
          {revisions.map((rev) => (
            <li key={rev.id} style={{ marginBottom: 24, position: 'relative' }}>
              <span style={{
                position: 'absolute',
                left: -26,
                top: 2,
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: 'var(--bg-darker)',
                border: '2px solid var(--accent-cyan)',
                boxShadow: '0 0 8px var(--accent-cyan)',
              }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                      #{rev.seq}
                    </span>
                    {rev.label && (
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(0, 245, 255, 0.05)',
                        border: '1px solid rgba(0, 245, 255, 0.15)',
                        color: 'var(--accent-cyan)',
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}>
                        {rev.label}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                    {new Date(rev.createdAt).toLocaleString()}
                  </span>
                </div>
                <button
                  disabled={restoring !== null}
                  onClick={() => handleRestore(rev.seq)}
                  className="outline-btn"
                  style={{ padding: '6px 12px', fontSize: 11 }}
                >
                  {restoring === rev.seq ? 'Restoring...' : 'Revert'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
