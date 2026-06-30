-- Real-Time Collaborative Sync Engine — PostgreSQL Schema
-- All tables use UUIDs as primary keys and TIMESTAMPTZ for all timestamps.
-- The operations table is an APPEND-ONLY event store — never UPDATE or DELETE rows.

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  display_name  TEXT        NOT NULL,
  color         TEXT        NOT NULL DEFAULT '#4F46E5', -- hex color for presence
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Documents ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL DEFAULT 'Untitled',
  owner_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted  BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_docs_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON documents(updated_at DESC);

-- ─── Document Permissions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_permissions (
  doc_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_perms_user ON document_permissions(user_id);

-- ─── User Documents Meta (Starred/Archived) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS user_documents_meta (
  doc_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_starred  BOOLEAN     NOT NULL DEFAULT false,
  is_archived BOOLEAN     NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_meta_user ON user_documents_meta(user_id);

-- ─── Invitations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  inviter_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_email TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  token         TEXT        NOT NULL UNIQUE,
  status        TEXT        NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_invitations_doc ON invitations(doc_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);

-- ─── Document Links ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_links (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  role        TEXT        NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_links_doc ON document_links(doc_id);
CREATE INDEX IF NOT EXISTS idx_links_token ON document_links(token);

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  read_at     TIMESTAMPTZ,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, created_at DESC);
-- ─── Refresh Tokens ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,  -- bcrypt hash of the raw token
  token_prefix TEXT       NOT NULL DEFAULT '',  -- first 8 chars for fast prefix lookup
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens(expires_at);
-- Fast prefix lookup: reduces bcrypt comparisons from O(N) to O(1)
CREATE INDEX IF NOT EXISTS idx_refresh_prefix ON refresh_tokens(token_prefix, expires_at)
  WHERE revoked = false;

-- ─── Sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id           UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  site_id          TEXT        NOT NULL,   -- UUID used by this client for UID generation
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at  TIMESTAMPTZ,
  last_seq         BIGINT      NOT NULL DEFAULT 0  -- last op seq acknowledged by client
);

CREATE INDEX IF NOT EXISTS idx_sessions_doc ON sessions(doc_id, disconnected_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ─── Operations (Append-Only Event Store) ────────────────────────────────────
-- CRITICAL: Never UPDATE or DELETE rows in this table.
-- All history, rollback, and replay depends on the integrity of this log.
CREATE TABLE IF NOT EXISTS operations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  session_id    UUID        NOT NULL,  -- FK deliberately not enforced for append perf
  user_id       UUID        NOT NULL REFERENCES users(id),
  seq           BIGINT      NOT NULL,  -- Monotonic per document (server-assigned)
  client_seq    BIGINT      NOT NULL,  -- Client's own counter (for ACK matching)
  op_type       TEXT        NOT NULL CHECK (op_type IN ('INSERT', 'DELETE', 'ROLLBACK')),
  op_data       JSONB       NOT NULL,  -- Serialized RGAOperation
  vector_clock  JSONB       NOT NULL DEFAULT '{}',
  nonce         TEXT        NOT NULL,  -- UUID for replay-attack prevention
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, seq)                 -- Enforce monotonic uniqueness per doc
);

-- Primary lookup: load ops for a document in order
CREATE INDEX IF NOT EXISTS idx_ops_doc_seq ON operations(doc_id, seq);
-- For reconnect: find ops after a given seq
CREATE INDEX IF NOT EXISTS idx_ops_doc_seq_partial ON operations(doc_id, seq)
  WHERE seq > 0;
-- For history views: time-based queries
CREATE INDEX IF NOT EXISTS idx_ops_doc_time ON operations(doc_id, created_at DESC);
-- For nonce dedup (also handled in Redis, PG is the fallback)
CREATE INDEX IF NOT EXISTS idx_ops_nonce ON operations(nonce);

-- ─── Snapshots ────────────────────────────────────────────────────────────────
-- Periodic full-state CRDT snapshots for efficient document loading.
-- Loading = latest snapshot + ops since snapshot.seq (not all ops from seq 0).
CREATE TABLE IF NOT EXISTS snapshots (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGINT      NOT NULL,   -- Snapshot includes ops through this seq
  data        JSONB       NOT NULL,   -- Serialized RGANode[] in document order
  text_hash   TEXT        NOT NULL,   -- SHA-256 of plain text for integrity verification
  node_count  INTEGER     NOT NULL,
  char_count  INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_doc_seq ON snapshots(doc_id, seq DESC);

-- ─── Revisions (Named Checkpoints) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revisions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGINT      NOT NULL,
  label       TEXT,                   -- Optional human-readable label
  created_by  UUID        NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(doc_id, seq DESC);

-- ─── Presence (Ephemeral) ─────────────────────────────────────────────────────
-- Presence data is primarily managed in Redis. This table is a fallback
-- for querying recent presence and audit purposes.
CREATE TABLE IF NOT EXISTS presence (
  session_id   UUID        PRIMARY KEY,
  doc_id       UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cursor_data  JSONB,      -- Serialized CursorPosition
  is_typing    BOOLEAN     NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_presence_doc ON presence(doc_id);

-- ─── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      UUID,
  user_id     UUID,
  action      TEXT        NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_doc ON audit_log(doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);

-- ─── Sequence Function ────────────────────────────────────────────────────────
-- Atomically reserves the next sequence number for a document.
-- Uses a dedicated document_sequences table with row-level locking.
-- This replaces the pg_advisory_xact_lock approach which was a per-document
-- serialization bottleneck under concurrent writes.
CREATE TABLE IF NOT EXISTS document_sequences (
  doc_id  UUID   PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  seq     BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION next_doc_seq(p_doc_id UUID)
RETURNS BIGINT AS $$
DECLARE
  v_seq BIGINT;
BEGIN
  -- Initialize if first op on this document
  INSERT INTO document_sequences (doc_id, seq) VALUES (p_doc_id, 0)
    ON CONFLICT (doc_id) DO NOTHING;

  -- Atomic increment with row-level lock (no advisory lock needed)
  UPDATE document_sequences
     SET seq = seq + 1
   WHERE doc_id = p_doc_id
   RETURNING seq INTO v_seq;

  RETURN v_seq;
END;
$$ LANGUAGE plpgsql;
