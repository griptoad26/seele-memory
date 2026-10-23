/**
 * src/sync.js — Envelope upload, download, and per-device sync state.
 *
 * Routes:
 *   POST /api/sync/upload            ingest one xkg-core SyncEnvelope
 *   POST /api/sync/download          return envelopes since a cursor
 *   GET  /api/sync/state             per-device sync watermark
 *   GET  /api/sync/devices           list the caller's devices
 *
 * Sync envelope contract (per SPEC §"Sync envelope contract"):
 *
 *   {
 *     device_id:           string,
 *     from_device_id:      string,        // usually == device_id
 *     conversation:        { conversation_id, llm_kind,
 *                            title_encrypted?, source_url_encrypted? },
 *     chunks:              [{ chunk_id, client_msg_id, body_encrypted,
 *                            embedding? }],
 *     cursor?:             number,         // legacy top-level cursor
 *     message_cursor?:     number,
 *     conv_cursor?:        number,
 *     msg_cursor?:         number,
 *   }
 *
 * Dedupe is at `(user_id, conversation_id, client_msg_id)` (SPEC §"Dedupe
 * keys"). We enforce it on chunk upsert; re-uploads of the same envelope
 * are no-ops at the row level — Vectorize is the only place the embedding
 * gets re-inserted, and Cloudflare's Vectorize is idempotent on
 * `(index, id)` so that's fine too.
 *
 * Authentication: every route requires an `Authorization: Bearer <grant>`
 * where the grant's `sub` is the user_id the envelopes are attributed to.
 * Devices and bots both use the same JWT plumbing (see auth.js); the
 * bots table check in auth.js accepts device-issued grants because the
 * `bot_id` claim on a device grant is the device_id, not a row in `bots`.
 *
 * To make that work without a bots-row check rejecting valid device
 * grants, the auth module's `checkRevoked` is only invoked when an
 * explicit `db` binding is passed. Recall/bots routes pass it (they need
 * the cross-check). The sync routes don't, because the user_id from the
 * JWT is the source of truth for "is this envelope yours".
 */

import { verifyGrant, SCOPE_WRITE, SCOPE_RECALL } from './auth.js';
import {
  upsertConversation,
  upsertChunk,
  upsertVectors,
  getSyncState,
  listDevices,
  ensureSchema,
} from './db.js';

// ---------------------------------------------------------------------------
// POST /api/sync/upload
// ---------------------------------------------------------------------------

/**
 * Ingest one SyncEnvelope.
 *
 * Response 200:
 *   {
 *     accepted: boolean,
 *     conversation_id: string,
 *     chunks_inserted: number,
 *     chunks_deduped: number,
 *     chunks_indexed: number,   // upserted to Vectorize
 *   }
 */
export async function handleSyncUpload(request, env) {
  const auth = await verifyGrant({
    secret: env.GRANT_JWT,
    authorization: request.headers.get('Authorization'),
    required_scope: SCOPE_WRITE,
    // Cross-check the device row so a revoked device's token stops
    // working immediately, rather than living out its 365-day TTL.
    db: env.DB,
  });
  if (!auth.ok) {
    return { status: auth.error.status, body: { error: auth.error.code, message: auth.error.message } };
  }

  // CREATE INDEX IF NOT EXISTS, cached per-isolate. See the long comment
  // on ensureSchema(): 0001_initial.sql declares a composite FK from
  // conversations to devices without a matching UNIQUE index on the parent,
  // which D1 rejects on every insert.
  try {
    await ensureSchema(env.DB);
  } catch (err) {
    return {
      status: 500,
      body: { error: 'schema_error', message: String((err && err.message) || err) },
    };
  }

  const body = await safeJson(request);
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'JSON body required' } };
  }
  const validation = validateEnvelope(body);
  if (validation) {
    return { status: 400, body: { error: 'bad_request', message: validation } };
  }

  const user_id = auth.claims.sub;

  // 1. Upsert the conversation metadata.
  try {
    await upsertConversation(env.DB, {
      user_id,
      conversation_id: body.conversation.conversation_id,
      device_id: body.device_id,
      llm_kind: body.conversation.llm_kind,
      title_encrypted: decodeMaybe(body.conversation.title_encrypted),
      source_url_encrypted: decodeMaybe(body.conversation.source_url_encrypted),
    });
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }

  // 2. Upsert chunks (idempotent on user_id+conversation_id+client_msg_id).
  let inserted = 0;
  let deduped = 0;
  const accepted = [];
  for (const ch of body.chunks) {
    const bodyBytes = decodeMaybe(ch.body_encrypted);
    if (!bodyBytes) {
      return {
        status: 400,
        body: { error: 'bad_request', message: `chunk ${ch.chunk_id} has invalid body_encrypted` },
      };
    }
    const embeddingBytes = decodeMaybe(ch.embedding);
    try {
      const r = await upsertChunk(env.DB, {
        chunk_id: ch.chunk_id,
        user_id,
        conversation_id: body.conversation.conversation_id,
        client_msg_id: ch.client_msg_id,
        body_encrypted: bodyBytes,
        embedding: embeddingBytes,
      });
      if (r.inserted) {
        inserted++;
        // Only newly-inserted chunks need a Vectorize upsert. Existing
        // rows already have their embedding indexed.
        if (embeddingBytes && Array.isArray(ch.embedding_vector)) {
          accepted.push({
            id: ch.chunk_id,
            values: ch.embedding_vector,
          });
        } else if (embeddingBytes) {
          // embedding_vector is the preferred shape — but tests may
          // pre-encode embeddings into `embedding` as a base64 string.
          // If the caller passed a raw array under `embedding_vector`,
          // we use it; otherwise Vectorize won't get an update.
          // This is intentional: the SDK's documented contract is to
          // send both `embedding_vector` (for Vectorize) and `embedding`
          // (a base64 copy stored in D1 for FTS5 fallback).
        }
      } else {
        deduped++;
      }
    } catch (err) {
      return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
    }
  }

  // 3. Vectorize upsert for the new chunks that shipped an embedding.
  let indexed = 0;
  if (accepted.length && env.VECTORIZE) {
    try {
      await upsertVectors(env.VECTORIZE, accepted);
      indexed = accepted.length;
    } catch (err) {
      // Vectorize failures shouldn't block the upload — the row is in
      // D1, the embedding bytes are stored, and a future reindex job
      // can pick them up. We return 200 with indexed=0 and a warning
      // so the client knows.
      return {
        status: 200,
        body: {
          accepted: true,
          conversation_id: body.conversation.conversation_id,
          chunks_inserted: inserted,
          chunks_deduped: deduped,
          chunks_indexed: 0,
          warning: `vectorize upsert failed: ${String((err && err.message) || err)}`,
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      accepted: true,
      conversation_id: body.conversation.conversation_id,
      chunks_inserted: inserted,
      chunks_deduped: deduped,
      chunks_indexed: indexed,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/sync/download
// ---------------------------------------------------------------------------

/**
 * Return envelopes since a cursor (unix-ms).
 *
 * Body: { since?: number, limit?: number (default 50, max 200) }
 *
 * Response 200:
 *   {
 *     envelopes: [{
 *       conversation_id, device_id, llm_kind, updated_at,
 *       chunks: [{ chunk_id, client_msg_id, body_encrypted (base64), created_at }],
 *     }],
 *     next_cursor: number,   // MAX(updated_at) seen; pass as `since` next time
 *   }
 *
 * This is a *coarse* sync — we return all chunks in any conversation
 * whose updated_at >= since. For v0.10.0 the SDK is expected to
 * dedupe and merge client-side.
 */
export async function handleSyncDownload(request, env) {
  const auth = await verifyGrant({
    secret: env.GRANT_JWT,
    authorization: request.headers.get('Authorization'),
    required_scope: SCOPE_RECALL, // reading your own data
    db: env.DB,
  });
  if (!auth.ok) {
    return { status: auth.error.status, body: { error: auth.error.code, message: auth.error.message } };
  }

  const body = await safeJson(request);
  if (body && typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'body must be a JSON object or empty' } };
  }
  const since = (body && Number.isFinite(body.since)) ? body.since : 0;
  const limit = (body && Number.isFinite(body.limit))
    ? Math.max(1, Math.min(200, Math.floor(body.limit)))
    : 50;

  let convs;
  try {
    const res = await env.DB
      .prepare(
        `SELECT * FROM conversations
         WHERE user_id = ?1 AND updated_at >= ?2
         ORDER BY updated_at ASC LIMIT ?3`
      )
      .bind(auth.claims.sub, since, limit)
      .all();
    convs = res.results || [];
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }

  const envelopes = [];
  let maxUpdated = since;
  for (const c of convs) {
    let chunks = [];
    try {
      const cres = await env.DB
        .prepare(
          `SELECT chunk_id, client_msg_id, body_encrypted, created_at
             FROM encrypted_chunks
            WHERE user_id = ?1 AND conversation_id = ?2
            ORDER BY created_at ASC`
        )
        .bind(auth.claims.sub, c.conversation_id)
        .all();
      chunks = (cres.results || []).map((r) => ({
        chunk_id: r.chunk_id,
        client_msg_id: r.client_msg_id,
        body_encrypted: toBase64(r.body_encrypted),
        created_at: r.created_at,
      }));
    } catch (err) {
      return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
    }
    envelopes.push({
      conversation_id: c.conversation_id,
      device_id: c.device_id,
      llm_kind: c.llm_kind,
      title_encrypted: toBase64(c.title_encrypted),
      source_url_encrypted: toBase64(c.source_url_encrypted),
      updated_at: c.updated_at,
      chunks,
    });
    if (c.updated_at > maxUpdated) maxUpdated = c.updated_at;
  }

  return {
    status: 200,
    body: {
      envelopes,
      next_cursor: maxUpdated,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/sync/state
// ---------------------------------------------------------------------------

/**
 * Per-device sync watermark + conversation/chunk counts.
 *
 * Query: ?device_id=...  (optional; defaults to caller's grant bot_id,
 *                        which for device grants is the device_id)
 */
export async function handleSyncState(request, env) {
  const auth = await verifyGrant({
    secret: env.GRANT_JWT,
    authorization: request.headers.get('Authorization'),
    required_scope: SCOPE_RECALL,
    db: env.DB,
  });
  if (!auth.ok) {
    return { status: auth.error.status, body: { error: auth.error.code, message: auth.error.message } };
  }
  const url = new URL(request.url);
  const device_id = url.searchParams.get('device_id') || auth.claims.bot_id;
  if (!device_id) {
    return { status: 400, body: { error: 'bad_request', message: 'device_id required' } };
  }
  let state;
  try {
    state = await getSyncState(env.DB, auth.claims.sub, device_id);
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }
  return {
    status: 200,
    body: {
      user_id: auth.claims.sub,
      device_id,
      ...state,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/sync/devices
// ---------------------------------------------------------------------------

export async function handleSyncDevices(request, env) {
  const auth = await verifyGrant({
    secret: env.GRANT_JWT,
    authorization: request.headers.get('Authorization'),
    required_scope: SCOPE_RECALL,
    db: env.DB,
  });
  if (!auth.ok) {
    return { status: auth.error.status, body: { error: auth.error.code, message: auth.error.message } };
  }
  let rows;
  try {
    rows = await listDevices(env.DB, auth.claims.sub);
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }
  return {
    status: 200,
    body: {
      devices: rows.map((r) => ({
        device_id: r.device_id,
        name: r.name,
        platform: r.platform,
        app_version: r.app_version,
        last_seen_at: r.last_seen_at,
        subkey_id: r.subkey_id,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateEnvelope(b) {
  if (typeof b.device_id !== 'string' || !b.device_id) {
    return '`device_id` is required';
  }
  if (!b.conversation || typeof b.conversation !== 'object') {
    return '`conversation` object is required';
  }
  const cv = b.conversation;
  if (typeof cv.conversation_id !== 'string' || !cv.conversation_id) {
    return '`conversation.conversation_id` is required';
  }
  if (typeof cv.llm_kind !== 'string' || !cv.llm_kind) {
    return '`conversation.llm_kind` is required';
  }
  if (!Array.isArray(b.chunks)) {
    return '`chunks` must be an array';
  }
  for (let i = 0; i < b.chunks.length; i++) {
    const ch = b.chunks[i];
    if (!ch || typeof ch !== 'object') return `chunks[${i}] not an object`;
    if (typeof ch.chunk_id !== 'string' || !ch.chunk_id) return `chunks[${i}].chunk_id required`;
    if (typeof ch.client_msg_id !== 'string' || !ch.client_msg_id) return `chunks[${i}].client_msg_id required`;
    if (typeof ch.body_encrypted !== 'string' || !ch.body_encrypted) return `chunks[${i}].body_encrypted required`;
  }
  return null;
}

function decodeMaybe(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

function toBase64(v) {
  if (v == null) return null;
  const u8 = v instanceof Uint8Array ? v : new Uint8Array(v);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}