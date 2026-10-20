/**
 * src/db.js — D1 + Vectorize helpers used by all handlers.
 *
 * The D1 binding is exposed as `env.DB` by wrangler; the Vectorize binding
 * as `env.VECTORIZE`. We keep the surface narrow on purpose:
 *
 *   * every query is parameterized (no string concat from request data)
 *   * every helper takes the binding as its first arg, so tests can pass
 *     a plain JS fake and assert behavior without a live D1
 *   * the Vectorize wrapper translates Cloudflare's verbose return shape
 *     into the small contract the recall code actually wants:
 *       { id, score }[] sorted by score desc
 *
 * D1 in production runs against Cloudflare's replicated SQLite. Our unit
 * tests use a Map-backed fake (see ../test/fake-d1.js) that implements the
 * subset of the `D1PreparedStatement` API we touch.
 */

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ArrayBuffer / Uint8Array / base64 string into a Uint8Array
 * suitable for storing in a D1 BLOB column.
 *
 * @param {ArrayBuffer | Uint8Array | string | null | undefined} v
 * @returns {Uint8Array | null}
 */
export function toBlob(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    // base64 → bytes
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError('cannot coerce value to Uint8Array blob');
}

/**
 * Inverse of toBlob: produce a base64 string from a Uint8Array.
 *
 * @param {ArrayBuffer | Uint8Array | null | undefined} v
 * @returns {string | null}
 */
export function fromBlob(v) {
  if (v == null) return null;
  const u8 = v instanceof Uint8Array ? v : new Uint8Array(v);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

/**
 * RFC3339-ish ISO timestamp helper — D1 stores integers, we keep everything
 * in unix-millis internally and only stringify at the edges.
 *
 * @param {number} ms
 */
export function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Insert (or no-op on conflict) a user row.
 *
 * @param {D1Database} db
 * @param {{ user_id: string, email_hash: string, public_key_ed25519: Uint8Array }} u
 */
export async function upsertUser(db, u) {
  await db
    .prepare(
      `INSERT INTO users (user_id, email_hash, public_key_ed25519, created_at)
         VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET
         email_hash = excluded.email_hash,
         public_key_ed25519 = excluded.public_key_ed25519`
    )
    .bind(u.user_id, u.email_hash, toBlob(u.public_key_ed25519), Date.now())
    .run();
}

export async function getUser(db, user_id) {
  return db
    .prepare('SELECT * FROM users WHERE user_id = ?1')
    .bind(user_id)
    .first();
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Register a device under a user. Idempotent on (user_id, device_id).
 *
 * @param {D1Database} db
 * @param {{
 *   device_id: string,
 *   user_id: string,
 *   name: string,
 *   platform: string,
 *   app_version: string,
 *   public_key_ed25519?: Uint8Array | null,
 *   subkey_id: string,
 * }} d
 */
export async function upsertDevice(db, d) {
  await db
    .prepare(
      `INSERT INTO devices (
         device_id, user_id, name, platform, app_version,
         public_key_ed25519, last_seen_at, subkey_id
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(device_id) DO UPDATE SET
         name = excluded.name,
         platform = excluded.platform,
         app_version = excluded.app_version,
         public_key_ed25519 = COALESCE(excluded.public_key_ed25519, devices.public_key_ed25519),
         last_seen_at = excluded.last_seen_at,
         subkey_id = excluded.subkey_id`
    )
    .bind(
      d.device_id,
      d.user_id,
      d.name,
      d.platform,
      d.app_version,
      toBlob(d.public_key_ed25519 ?? null),
      Date.now(),
      d.subkey_id,
    )
    .run();
}

export async function listDevices(db, user_id) {
  const res = await db
    .prepare('SELECT * FROM devices WHERE user_id = ?1 ORDER BY last_seen_at DESC')
    .bind(user_id)
    .all();
  return res.results || [];
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Upsert a conversation metadata row. Idempotent on (user_id, conversation_id).
 *
 * @param {D1Database} db
 * @param {{
 *   user_id: string,
 *   conversation_id: string,
 *   device_id: string,
 *   llm_kind: string,
 *   title_encrypted?: Uint8Array | null,
 *   source_url_encrypted?: Uint8Array | null,
 * }} c
 */
export async function upsertConversation(db, c) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO conversations (
         user_id, conversation_id, device_id, llm_kind,
         title_encrypted, source_url_encrypted, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(user_id, conversation_id) DO UPDATE SET
         device_id = excluded.device_id,
         llm_kind = excluded.llm_kind,
         title_encrypted = COALESCE(excluded.title_encrypted, conversations.title_encrypted),
         source_url_encrypted = COALESCE(excluded.source_url_encrypted, conversations.source_url_encrypted),
         updated_at = excluded.updated_at`
    )
    .bind(
      c.user_id,
      c.conversation_id,
      c.device_id,
      c.llm_kind,
      toBlob(c.title_encrypted ?? null),
      toBlob(c.source_url_encrypted ?? null),
      now,
    )
    .run();
}

export async function getConversation(db, user_id, conversation_id) {
  return db
    .prepare('SELECT * FROM conversations WHERE user_id = ?1 AND conversation_id = ?2')
    .bind(user_id, conversation_id)
    .first();
}

// ---------------------------------------------------------------------------
// Encrypted chunks
// ---------------------------------------------------------------------------

/**
 * Upsert one encrypted chunk. `client_msg_id` is stored on the chunk row
 * for idempotent dedupe at `(user_id, conversation_id, client_msg_id)`.
 *
 * @param {D1Database} db
 * @param {{
 *   chunk_id: string,
 *   user_id: string,
 *   conversation_id: string | null,
 *   client_msg_id: string,
 *   body_encrypted: Uint8Array,
 *   embedding?: Uint8Array | null,
 * }} c
 * @returns {Promise<{ inserted: boolean }>}
 */
export async function upsertChunk(db, c) {
  // Idempotency: dedupe on (user_id, conversation_id, client_msg_id).
  // The chunk_id PK alone would let a client repurpose an id, which we
  // don't want — the same logical message should hash to the same row
  // even if chunk_ids are re-derived.
  const existing = await db
    .prepare(
      `SELECT chunk_id FROM encrypted_chunks
       WHERE user_id = ?1 AND conversation_id IS ?2 AND client_msg_id = ?3`
    )
    .bind(c.user_id, c.conversation_id, c.client_msg_id)
    .first();
  if (existing) {
    return { inserted: false, chunk_id: existing.chunk_id };
  }
  await db
    .prepare(
      `INSERT INTO encrypted_chunks (
         chunk_id, user_id, conversation_id, client_msg_id,
         body_encrypted, embedding, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(
      c.chunk_id,
      c.user_id,
      c.conversation_id,
      c.client_msg_id,
      toBlob(c.body_encrypted),
      toBlob(c.embedding ?? null),
      Date.now(),
    )
    .run();
  return { inserted: true, chunk_id: c.chunk_id };
}

export async function getChunk(db, user_id, chunk_id) {
  return db
    .prepare('SELECT * FROM encrypted_chunks WHERE user_id = ?1 AND chunk_id = ?2')
    .bind(user_id, chunk_id)
    .first();
}

/**
 * Fetch many chunks by id, filtered by user_id (cross-user isolation).
 * @param {D1Database} db
 * @param {string} user_id
 * @param {string[]} chunk_ids
 * @returns {Promise<any[]>}
 */
export async function getChunksByIds(db, user_id, chunk_ids) {
  if (!chunk_ids.length) return [];
  const placeholders = chunk_ids.map((_, i) => `?${i + 2}`).join(',');
  const sql =
    `SELECT * FROM encrypted_chunks WHERE user_id = ?1 AND chunk_id IN (${placeholders})`;
  const res = await db
    .prepare(sql)
    .bind(user_id, ...chunk_ids)
    .all();
  return res.results || [];
}

/**
 * Keyword scan over the caller's own chunks. D1 has no FTS5 today, so we do
 * a coarse LIKE match on the chunk_id (clients include searchable tokens in
 * the chunk_id prefix per xkg-core convention). For v0.10.0 this is the
 * "no vector index" fallback spelled out in the dispatch brief.
 *
 * @param {D1Database} db
 * @param {{ user_id: string, query: string, limit: number }} args
 */
export async function keywordScan(db, { user_id, query, limit }) {
  const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
  const res = await db
    .prepare(
      `SELECT * FROM encrypted_chunks
       WHERE user_id = ?1 AND chunk_id LIKE ?2 ESCAPE '\\'
       ORDER BY created_at DESC
       LIMIT ?3`
    )
    .bind(user_id, like, limit)
    .all();
  return res.results || [];
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export async function createBot(db, b) {
  await db
    .prepare(
      `INSERT INTO bots (
         bot_id, user_id, name, public_key_ed25519,
         scope_tags, expires_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(
      b.bot_id,
      b.user_id,
      b.name,
      toBlob(b.public_key_ed25519),
      JSON.stringify(b.scope_tags || []),
      b.expires_at || null,
      Date.now(),
    )
    .run();
}

export async function getBot(db, bot_id) {
  return db
    .prepare('SELECT * FROM bots WHERE bot_id = ?1')
    .bind(bot_id)
    .first();
}

export async function listBots(db, user_id) {
  const res = await db
    .prepare(
      `SELECT * FROM bots WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC`
    )
    .bind(user_id)
    .all();
  return res.results || [];
}

export async function revokeBot(db, bot_id, user_id) {
  // Only revoke if the bot actually belongs to user_id — guards against
  // cross-user revocation attempts.
  return db
    .prepare(
      `UPDATE bots SET revoked_at = ?1
       WHERE bot_id = ?2 AND user_id = ?3 AND revoked_at IS NULL`
    )
    .bind(Date.now(), bot_id, user_id)
    .run();
}

// ---------------------------------------------------------------------------
// Sync state (per-device cursor)
// ---------------------------------------------------------------------------

/**
 * Compute a per-device, per-user watermark. We model "last seen" as
 * MAX(updated_at) over the user's conversations, plus a chunk count
 * for sanity. SPEC §"Sync endpoints" describes this as cursors; we
 * return the highest updated_at as a single cursor for v0.10.0.
 *
 * We split into multiple single-aggregate queries because D1 / SQLite
 * handles each aggregate distinctly and the implementation here only
 * needs to mirror that.
 */
export async function getSyncState(db, user_id, device_id) {
  const cursorRow = await db
    .prepare(
      `SELECT MAX(updated_at) AS cursor
       FROM conversations WHERE user_id = ?1 AND device_id = ?2`
    )
    .bind(user_id, device_id)
    .first();
  const convCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS conv_count
       FROM conversations WHERE user_id = ?1 AND device_id = ?2`
    )
    .bind(user_id, device_id)
    .first();
  const chunkCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS chunk_count FROM encrypted_chunks WHERE user_id = ?1`
    )
    .bind(user_id)
    .first();
  return {
    cursor: (cursorRow && cursorRow.cursor) || 0,
    conv_count: (convCountRow && convCountRow.conv_count) || 0,
    chunk_count: (chunkCountRow && chunkCountRow.chunk_count) || 0,
  };
}

// ---------------------------------------------------------------------------
// Vectorize wrapper
// ---------------------------------------------------------------------------

/**
 * Upsert vectors into Vectorize. We expect the caller to pass chunks already
 * stored in D1 — Vectorize IDs are the chunk_ids so the round-trip is trivial.
 *
 * The real Cloudflare binding returns `mutationId` strings; we wrap that
 * with a small typed return so callers can mock it in tests.
 *
 * @param {VectorizeIndex} v
 * @param {Array<{ id: string, values: number[] | Float32Array }>} vectors
 */
export async function upsertVectors(v, vectors) {
  if (!vectors.length) return { mutationId: 'noop' };
  return v.upsert(vectors);
}

/**
 * Query Vectorize for top-K neighbors of a query vector.
 * Returns [{ id, score }] sorted by score desc.
 *
 * @param {VectorizeIndex} v
 * @param {{ values: number[] | Float32Array, topK: number }} q
 */
export async function queryVectors(v, { values, topK }) {
  const res = await v.query(values, {
    topK,
    returnMetadata: false,
    returnValues: false,
  });
  const matches = (res && res.matches) || [];
  return matches
    .map((m) => ({ id: m.id, score: m.score }))
    .sort((a, b) => b.score - a.score);
}