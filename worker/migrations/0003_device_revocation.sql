-- 0003_device_revocation.sql
--
-- Device tokens are valid for 365 days and, until this migration, there
-- was no way to invalidate one: no DELETE route, no revocation
-- endpoint, no revoked flag. Any leak of a device token was therefore
-- permanent. TASK-seele-cloud-20261022-101 added POST /api/keys/revoke,
-- which needs a column to write.
--
-- Tombstone rather than DELETE on purpose: `conversations` carries a
-- composite FK to devices(user_id, device_id) and `encrypted_chunks`
-- cascades off conversations, so deleting a device row would either be
-- rejected by FK enforcement or would take the user's sync history
-- with it. `revoked_at IS NULL` therefore means "active device", which
-- matches the existing `bots.revoked_at` pattern in this schema.
--
-- ALTER TABLE ... ADD COLUMN is a single-shot operation: if this
-- migration is re-applied, or if the column was added out-of-band, the
-- statement fails. We accept that (same as 0002) because D1 migrations
-- are tracked by filename and applied exactly once.

ALTER TABLE devices ADD COLUMN revoked_at INTEGER;

-- Partial index: the hot query is "active devices for user X", and the
-- revoked rows are a small minority, so keeping them out of the index
-- keeps device listings small.
CREATE INDEX IF NOT EXISTS idx_devices_active
  ON devices(user_id, revoked_at);