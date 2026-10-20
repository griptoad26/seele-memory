-- 0002_alter_encrypted_chunks.sql
--
-- 0001_initial.sql defined `encrypted_chunks` without the columns the
-- sync envelope paths actually need. Live integration testing revealed
-- this on the first real upload (after my own pre-flight check had
-- green tests locally because the fake-D1 test harness is permissive
-- about column gaps). This migration adds them idempotently so we
-- can apply it on the live DB without rebuilding the table.
--
-- Adds:
--   * client_msg_id  — the caller-supplied deduplication key from the
--                       SyncEnvelope (the bundling/dedupe contract in
--                       SPEC §"Sync envelope contract").
--   * device_id     — which device this chunk was synced from; needed
--                       for per-device sync cursors and the device-aware
--                       recall filter.
--   * vector_id     — opaque id to look up the matching row in the
--                       Vectorize index (we never store the embedding
--                       vector and the Vectorize id side-by-side in
--                       D1 to keep size down).
--
-- This migration also adds the dedupe unique index the SPEC actually
-- requires (`(user_id, conversation_id, client_msg_id)`), which
-- 0001_initial.sql mentioned in a comment but forgot to declare.

ALTER TABLE encrypted_chunks ADD COLUMN client_msg_id TEXT;

ALTER TABLE encrypted_chunks ADD COLUMN device_id TEXT;

ALTER TABLE encrypted_chunks ADD COLUMN vector_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_dedupe
  ON encrypted_chunks(user_id, conversation_id, client_msg_id);

CREATE INDEX IF NOT EXISTS idx_chunks_device
  ON encrypted_chunks(user_id, device_id, created_at);
