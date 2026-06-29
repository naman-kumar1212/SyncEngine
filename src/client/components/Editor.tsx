import React, { useRef, useState } from 'react';
import { useCollaborativeDoc } from '../hooks/useCollaborativeDoc';
import { PresenceOverlay } from './PresenceOverlay';
import { RevisionHistory } from './RevisionHistory';

interface EditorProps {
  docId: string;
  accessToken: string;
  title: string;
  ownerName: string;
}

export const Editor: React.FC<EditorProps> = ({ docId, accessToken, title, ownerName }) => {
  const {
    text,
    status,
    presence,
    sessionId,
    localInsert,
    localDelete,
    localBatchEdit,
    sendCursor,
  } = useCollaborativeDoc(docId, accessToken);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [tagName, setTagName] = useState('');
  const [tagSaving, setTagSaving] = useState(false);

  // Sync cursor selection to peers
  const handleSelect = () => {
    if (!textareaRef.current) return;
    const start = textareaRef.current.selectionStart;
    sendCursor(start);
  };

  // Basic single-char insert/delete change handler
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value;
    const prevText = text;

    if (nextText.length > prevText.length) {
      const start = textareaRef.current?.selectionStart ?? nextText.length;
      const idx = start - 1;
      const char = nextText[idx];
      localInsert(idx, char);
    } else if (nextText.length < prevText.length) {
      const start = textareaRef.current?.selectionStart ?? nextText.length;
      const idx = start;
      localDelete(idx);
    } else {
      localBatchEdit(prevText, nextText);
    }
  };

  // Saves a named checkpoint/revision tag
  const handleSaveTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tagName.trim()) return;

    setTagSaving(true);
    try {
      const res = await fetch(`/api/docs/${docId}/history/revisions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ label: tagName }),
      });

      if (!res.ok) throw new Error('Failed to create revision tag');

      setTagName('');
      alert('Revision tag saved!');
      window.location.reload(); // refresh history list
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setTagSaving(false);
    }
  };

  // Compute status colors
  const statusColor = 
    status === 'connected' ? 'var(--signal-success)' :
    status === 'connecting' ? 'var(--signal-warning)' :
    'var(--signal-error)';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24, gap: 24, maxWidth: 1400, width: '100%', margin: '0 auto' }}>
      {/* Workspace Header */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: statusColor,
            boxShadow: `0 0 10px ${statusColor}`,
            animation: status === 'connected' ? 'none' : 'pulse 1.5s infinite'
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: 0.5 }}>
            {status}
          </span>
        </div>
        <PresenceOverlay presence={presence} sessionId={sessionId} />
      </div>

      {/* Main Workspace Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, flex: 1 }}>
        {/* Editor Area */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '65vh' }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 20px',
            borderBottom: '1px solid var(--border-muted)',
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}>
            <span>Collaborative Buffer</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{text.length} chars</span>
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyUp={handleSelect}
            style={{
              flex: 1,
              width: '100%',
              padding: 24,
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 15,
              lineHeight: 1.6,
              resize: 'none',
            }}
            placeholder="Start typing your collaborative masterpiece here..."
          />
        </div>

        {/* Sidebar Area */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Milestone Tagger */}
          <div className="glass-panel" style={{ padding: 20 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 16 }}>
              Tag Revision
            </h3>
            <form onSubmit={handleSaveTag} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                placeholder="e.g. Milestone 1"
                className="form-input"
                style={{ fontSize: 13 }}
              />
              <button
                type="submit"
                disabled={tagSaving || !tagName.trim()}
                className="glow-btn"
                style={{ padding: '8px 16px', fontSize: 12 }}
              >
                {tagSaving ? 'Saving...' : 'Create Milestone'}
              </button>
            </form>
          </div>

          {/* Timeline List */}
          <RevisionHistory
            docId={docId}
            accessToken={accessToken}
            onRestoreSuccess={() => {
              window.location.reload();
            }}
          />
        </div>
      </div>
    </div>
  );
};
