/**
 * src/recall.js — Vector + keyword recall over the user's encrypted corpus.
 *
 * ============================================================================
 *  PRIVACY-CRITICAL DESIGN NOTE — Option D (Sovereign / E2EE)
 * ============================================================================
 *
 *  Per SPEC §"Privacy model", seele-cloud stores **only ciphertext blobs**
 *  for conversation content. The user's AES-256-GCM content key never
 *  leaves their device. The Worker cannot decrypt anything — by design.
 *
 *  This has two non-obvious consequences that shape the recall API:
 *
 *  1. **Vectorize is plaintext-shaped.** The 384-dim embeddings we store
 *     in Cloudflare Vectorize are derived from the user's plaintext
 *     *before* encryption (per SPEC §"Embedding model": "Computed on-device
 *     at capture time"). An embedding is reversible in principle for
 *     short snippets, but it's far less of a leak than the raw plaintext
 *     itself, and it's the only way to do semantic search server-side
 *     without holding keys. We accept this tradeoff explicitly.
 *
 *  2. **recall() and full-recall() return ciphertext, not plaintext.**
 *     The caller (the bot SDK, xkg-desktop's preview pane, etc.) holds
 *     the per-session content subkey and decrypts locally. The Worker
 *     never sees the user's search query's plaintext response either:
 *     the bot mints an embedding locally, sends only the *vector* to
 *     `/mem/v1/recall`, and the Worker returns top-K opaque blob IDs +
 *     ciphertext. Round-trip: query plaintext → embedding → top-K ids →
 *     ciphertext → caller decrypts.
 *
 *  `full-recall()` is the same shape, but scans D1 by keyword (chunk_id
 *  prefix) instead of Vectorize. It's the no-vector-index fallback for
 *  when the bot SDK doesn't have an embedding model available — e.g. a
 *  lightweight CLI tool. It still returns ciphertext.
 *
 *  Cross-user isolation is enforced at every D1 query: `WHERE user_id = ?`
 *  binds the caller's JWT `sub` claim. A miscoded recall cannot return
 *  another user's chunks because the SQL itself filters them out. The
 *  vitest suite asserts this with two JWTs minted from two different
 *  grant secrets; see test/recall.test.js.
 *
 * ============================================================================
 */

import { verifyGrant, SCOPE_RECALL } from './auth.js';
import { getChunksByIds, keywordScan } from './db.js';

// Top-K bounds. SPEC §"Recall API" doesn't pin a hard limit; we clamp to
// keep the response body reasonable. Bot SDKs can request anything up to
// MAX_TOP_K; the Worker silently clamps anything higher.
export const DEFAULT_TOP_K = 10;
export const MAX_TOP_K = 50;

// Maximum allowed query vector length. Our Vectorize index is 384 dims
// (per wrangler.toml), so anything longer is a client bug; we reject
// rather than truncate so the bug surfaces immediately.
export const EXPECTED_VECTOR_DIMS = 384;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /mem/v1/recall
 *
 * Headers: Authorization: Bearer <grant_jwt>  (scope: memory:recall or memory:write)
 *
 * Body:
 *   {
 *     query_vector: number[],                 // 384-dim embedding of the
 *                                            // plaintext query, computed
 *                                            // client-side.
 *     top_k:       number (default 10, max 50)
 *     since?:      number (unix-ms)          // only return chunks newer
 *   }
 *
 * Response 200:
 *   {
 *     snippets: [{
 *       chunk_id:        string,
 *       score:           number,
 *       conversation_id: string | null,
 *       created_at:      number,
 *       body_encrypted:  string,             // base64 ciphertext
 *     }],
 *     query_id: string,
 *   }
 */
export async function handleRecall(request, env) {
  const auth = await verifyGrant({
    secret: env.GRANT_JWT,
    authorization: request.headers.get('Authorization'),
    required_scope: SCOPE_RECALL,
    db: env.DB,
  });
  if (!auth.ok) {
    return { status: auth.error.status, body: { error: auth.error.code, message: auth.error.message } };
  }

  const body = await safeJson(request);
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'JSON body required' } };
  }

  if (!Array.isArray(body.query_vector)) {
    return {
      status: 400,
      body: { error: 'bad_request', message: '`query_vector` must be an array of 384 numbers' },
    };
  }
  if (body.query_vector.length !== EXPECTED_VECTOR_DIMS) {
    return {
      status: 400,
      body: {
        error: 'bad_request',
        message: `query_vector must be ${EXPECTED_VECTOR_DIMS} dims (got ${body.query_vector.length})`,
      },
    };
  }
  if (body.query_vector.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return {
      status: 400,
      body: { error: 'bad_request', message: 'query_vector must contain finite numbers only' },
    };
  }

  const top_k = clampTopK(body.top_k);
  const since = typeof body.since === 'number' && body.since > 0 ? body.since : null;

  // Vectorize query — top-K neighbor chunk_ids.
  let matches;
  try {
    matches = await env.VECTORIZE.query(body.query_vector, {
      topK: top_k,
      returnMetadata: false,
      returnValues: false,
    });
  } catch (err) {
    return { status: 500, body: { error: 'vectorize_error', message: String((err && err.message) || err) } };
  }
  const ranked = ((matches && matches.matches) || [])
    .map((m) => ({ id: m.id, score: m.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top_k);

  if (!ranked.length) {
    return { status: 200, body: { snippets: [], query_id: uuid() } };
  }

  // Fetch the corresponding rows, scoped to the caller's user_id.
  // Cross-user isolation: getChunksByIds binds user_id = auth.claims.sub
  // so even if Vectorize returned ids that don't belong to the caller,
  // they're dropped here.
  const rows = await getChunksByIds(env.DB, auth.claims.sub, ranked.map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));

  let snippets = ranked
    .filter((r) => byId.has(r.id))
    .map((r) => {
      const row = byId.get(r.id);
      return {
        chunk_id: r.id,
        score: r.score,
        conversation_id: row.conversation_id,
        created_at: row.created_at,
        body_encrypted: toBase64(row.body_encrypted),
      };
    });

  if (since != null) {
    snippets = snippets.filter((s) => s.created_at >= since);
  }

  return {
    status: 200,
    body: {
      snippets,
      query_id: uuid(),
    },
  };
}

/**
 * POST /mem/v1/full-recall
 *
 * Headers: Authorization: Bearer <grant_jwt>  (scope: memory:recall or memory:write)
 *
 * Body:
 *   {
 *     query: string,           // keyword(s) — chunk_id LIKE scan
 *     limit?: number (default 10, max 50)
 *     since?: number (unix-ms)
 *   }
 *
 * Response 200: { matches: [{...same shape as recall snippets...}], query_id }
 *
 * Per SPEC §"Recall API" the keyword path doesn't go through Vectorize —
 * it's a D1 LIKE scan over the caller's own chunk_id values. Returns
 * ciphertext (Option D privacy stance). See the file-level PRIVACY-CRITICAL
 * note above.
 */
export async function handleFullRecall(request, env) {
  const auth = await verifyGrant({
    secret: env.GRANT_JWT,
    authorization: request.headers.get('Authorization'),
    required_scope: SCOPE_RECALL,
    db: env.DB,
  });
  if (!auth.ok) {
    return { status: auth.error.status, body: { error: auth.error.code, message: auth.error.message } };
  }

  const body = await safeJson(request);
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'JSON body required' } };
  }
  if (typeof body.query !== 'string' || !body.query) {
    return { status: 400, body: { error: 'bad_request', message: '`query` (non-empty string) is required' } };
  }
  const limit = clampTopK(body.limit);
  const since = typeof body.since === 'number' && body.since > 0 ? body.since : null;

  let rows;
  try {
    rows = await keywordScan(env.DB, {
      user_id: auth.claims.sub,
      query: body.query,
      limit,
    });
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }
  if (since != null) {
    rows = rows.filter((r) => r.created_at >= since);
  }
  return {
    status: 200,
    body: {
      matches: rows.map((r) => ({
        chunk_id: r.chunk_id,
        score: 1.0, // keyword match — no semantic score, just present-or-not
        conversation_id: r.conversation_id,
        created_at: r.created_at,
        body_encrypted: toBase64(r.body_encrypted),
      })),
      query_id: uuid(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampTopK(n) {
  if (!Number.isFinite(n)) return DEFAULT_TOP_K;
  return Math.max(1, Math.min(MAX_TOP_K, Math.floor(n)));
}

async function safeJson(request) {
  try {
    return await request.json();
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

function uuid() {
  return crypto.randomUUID();
}