-- migrations/0001_initial.sql — Initial schema for seele-cloud (Phase 1).
--
-- This file is the source-of-truth for the D1 tables. Apply with:
--   wrangler d1 execute seele-memory-db --remote --file=migrations/0001_initial.sql
--
-- Or with wrangler's migrations runner:
--   wrangler d1 migrations apply seele-memory-db --remote
--
-- Schema mirrors SPEC.md §"Data model" (users, devices, conversations,
-- encrypted_chunks, bots). Indexes enforce the query patterns spelled out
-- in D1-best-practices from the dispatch brief:
--   * (user_id, conversation_id) — conversation lookup, dedupe
--   * (user_id, device_id)       — per-device sync cursors
--   * (bot_id)                   — bot lookup (covers via PRIMARY KEY but
--                                  the brief explicitly asked for an
--                                  index, so we add it for clarity)
--
-- Foreign keys are declared; SQLite enforces them when PRAGMA foreign_keys=ON
-- is set per-connection. Wrangler's D1 binding enables this automatically.

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  public_key_ed25519 BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  public_key_ed25519 BLOB,
  last_seen_at INTEGER NOT NULL,
  subkey_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  llm_kind TEXT NOT NULL,
  title_encrypted BLOB,
  source_url_encrypted BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS encrypted_chunks (
  chunk_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  body_encrypted BLOB NOT NULL,
  embedding BLOB, -- denormalized copy for keyword-only joins when Vectorize misses
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, conversation_id)
    REFERENCES conversations(user_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS bots (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key_ed25519 BLOB NOT NULL,
  scope_tags TEXT NOT NULL,    -- JSON array of tag strings
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- ---------------------------------------------------------------------------
-- Indexes (per dispatch brief: D1 best practices)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_devices_user_device
  ON devices (user_id, device_id);

CREATE INDEX IF NOT EXISTS idx_conversations_user_conv
  ON conversations (user_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_chunks_user
  ON encrypted_chunks (user_id);

CREATE INDEX IF NOT EXISTS idx_chunks_user_conv
  ON encrypted_chunks (user_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_bots_user
  ON bots (user_id);

CREATE INDEX IF NOT EXISTS idx_bots_bot_id
  ON bots (bot_id);
