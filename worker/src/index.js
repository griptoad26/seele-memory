/**
 * src/index.js — seele-cloud Cloudflare Worker
 *
 * TASK-seele-cloud-20261019-093.
 *
 * This Worker serves two co-resident responsibilities:
 *
 *   1. **seele-cloud API** — the memory backend described in SPEC.md.
 *      Mounted under `/api/mem/*` (health + recall) and `/api/sync/*`.
 *      Phase 1 (this file) lands `/api/mem/health` plus D1 + Vectorize
 *      bindings so the schema and index are live before any sync or
 *      recall code ships.
 *
 *   2. **seele-fresh proxy** — cache-busting reverse proxy carried over
 *      from `devops-agent/drafts/cf-worker/seele-fresh`. Preserved
 *      because seele.agency is a GitHub Pages site and the original
 *      proxy exists to strip Cloudflare caching so users always get
 *      fresh content. Mounted under `/fresh/*`; everything else falls
 *      through to the same upstream (GitHub Pages).
 *
 * Per SPEC.md §Open Questions:
 *   * Embedding model   → @xenova/all-MiniLM-L6-v2 (384 dims, cosine).
 *   * CF Access IdP     → built-in email-link allowlist.
 *   * Subkey rotation   → never (user re-derives from phrase).
 *   * Grant JWT lifetime → 900 s default; user-configurable per bot.
 */

// ---------------------------------------------------------------------------
// Version / metadata
// ---------------------------------------------------------------------------

const SERVICE = 'seele-cloud';
const VERSION = '0.2.0-phase2';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const DEFAULT_ORIGINS = [
  'https://seele.agency',
  'http://localhost:3000',
  'http://localhost:8090',
];

function allowedOrigins(env) {
  const raw = env.CORS_ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',');
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = allowedOrigins(env);
  const allowOrigin =
    origin && allowed.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'content-type, authorization, x-seele-key, cf-access-client-id, cf-access-client-secret',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'x-seele-version',
  };
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-seele-version': VERSION,
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// /api/mem/health — Phase 1 acceptance criterion
// ---------------------------------------------------------------------------

async function handleHealth(request, env) {
  const checks = {};

  // D1 probe: a trivial read against sqlite_master.
  if (env.DB) {
    try {
      const started = Date.now();
      await env.DB
        .prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1")
        .first();
      checks.d1 = { ok: true, latency_ms: Date.now() - started };
    } catch (err) {
      checks.d1 = {
        ok: false,
        error: String((err && err.message) || err),
      };
    }
  } else {
    checks.d1 = { ok: false, error: 'binding not configured' };
  }

  // Vectorize probe: describe the index and read its dimension count.
  if (env.VECTORIZE) {
    try {
      const started = Date.now();
      const info = await env.VECTORIZE.describe();
      checks.vectorize = {
        ok: true,
        latency_ms: Date.now() - started,
        dimensions: info && info.dimensions,
        metric: info && info.metric,
      };
    } catch (err) {
      checks.vectorize = {
        ok: false,
        error: String((err && err.message) || err),
      };
    }
  } else {
    checks.vectorize = { ok: false, error: 'binding not configured' };
  }

  // Count the tables the Phase 1 migration should have created. Missing
  // tables mean migrations haven't been applied yet — reported, not fatal.
  if (env.DB && checks.d1.ok) {
    try {
      const row = await env.DB
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"
        )
        .first();
      checks.d1.tables = row ? Number(row.n) : 0;
    } catch (_) {
      /* non-fatal */
    }
  }

  return json(request, env, {
    ok: true,
    service: SERVICE,
    version: VERSION,
    phase: 2,
    environment: env.ENVIRONMENT || 'unknown',
    checks,
    // Contract per SPEC.md: "Status: { ok, version, last_reindex_at }"
    last_reindex_at: env.LAST_REINDEX_AT || null,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Generic handler dispatcher.
//
// Each route module returns `{ status, body }`; we turn that into a Response
// here. Centralizing the JSON envelope makes CORS + version headers
// uniform across the surface and means individual handlers never need to
// touch Response objects.
// ---------------------------------------------------------------------------

async function dispatch(request, env, handler) {
  try {
    const r = await handler(request, env);
    return json(request, env, r.body || {}, r.status || 200);
  } catch (err) {
    return json(request, env, {
      ok: false,
      service: SERVICE,
      version: VERSION,
      error: 'internal_error',
      message: String((err && err.message) || err),
    }, 500);
  }
}

// ---------------------------------------------------------------------------
// seele-fresh proxy — co-resident cache-busting reverse proxy.
//
// Carried over from devops-agent/drafts/cf-worker/seele-fresh/src/index.js
// so both responsibilities live in one Worker (one route, one deploy).
// Mounted under /fresh/*; everything else (404 fall-through, etc.) also
// forwards to the same origin so the site behaves identically pre/post
// cutover.
// ---------------------------------------------------------------------------

function freshnessHeaders(target) {
  return {
    'Cache-Control': 'public, max-age=0, s-maxage=0, must-revalidate',
    Pragma: 'no-cache',
    'X-Seele-Fresh': new Date().toISOString(),
    'X-Seele-Origin': target,
  };
}

async function handleFreshProxy(request, env, url) {
  const origin = env.ORIGIN_URL || 'https://griptoad26.github.io';
  // Strip the /fresh mount prefix before forwarding, so the origin sees
  // the path it would have served directly. Other paths just forward as-is.
  const forwardPath =
    url.pathname === '/fresh'
      ? '/'
      : url.pathname.replace(/^\/fresh/, '') || '/';
  const target = origin + forwardPath + url.search;

  const headers = new Headers(request.headers);
  headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  headers.set('Pragma', 'no-cache');

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : request.body,
      redirect: 'follow',
    });
  } catch (err) {
    return json(
      request,
      env,
      {
        error: 'origin_unreachable',
        target,
        message: String((err && err.message) || err),
      },
      502
    );
  }

  const fresh = freshnessHeaders(target);
  const out = new Response(upstream.body, upstream);
  for (const [k, v] of Object.entries(fresh)) out.headers.set(k, v);
  out.headers.delete('CF-Cache-Status');
  out.headers.delete('Age');
  return out;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Preflight for every API route.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    // ----- Health --------------------------------------------------------
    if (path === '/api/mem/health' || path === '/health') {
      return await handleHealth(request, env);
    }

    // ----- seele-fresh co-resident proxy (explicit mount) ---------------
    if (path === '/fresh' || path.startsWith('/fresh/')) {
      return await handleFreshProxy(request, env, url);
    }

    try {
      // ----- Auth: device registration (Access-gated) -------------------
      if (path === '/api/keys/register' && request.method === 'POST') {
        const { handleRegisterDevice } = await import('./keys.js');
        return await dispatch(request, env, handleRegisterDevice);
      }

      // ----- Auth: device revocation (Access-gated) ---------------------
      // Exists so a leaked 365-day device token can be invalidated.
      // Without this, revocation means "wait out the TTL".
      if (path === '/api/keys/revoke' && request.method === 'POST') {
        const { handleRevokeDevice } = await import('./keys.js');
        return await dispatch(request, env, handleRevokeDevice);
      }

      // ----- Bots: POST /api/bots ----------------------------------------
      if (path === '/api/bots' && request.method === 'POST') {
        const { handleCreateBot } = await import('./bots.js');
        return await dispatch(request, env, (req, env_) => handleCreateBot(req, env_, null));
      }
      if (path === '/api/bots' && request.method === 'GET') {
        const { handleListBots } = await import('./bots.js');
        return await dispatch(request, env, handleListBots);
      }

      // ----- Bots: POST /api/bots/:id/revoke -----------------------------
      // Pattern: /api/bots/<bot_id>/revoke. We avoid a router lib; the
      // shape is small enough to parse inline.
      const revokeMatch = /^\/api\/bots\/([A-Za-z0-9_-]+)\/revoke\/?$/.exec(path);
      if (revokeMatch && request.method === 'POST') {
        const bot_id = revokeMatch[1];
        const { handleRevokeBot } = await import('./bots.js');
        return await dispatch(request, env, (req, env_) => handleRevokeBot(req, env_, bot_id));
      }

      // ----- Recall: POST /mem/v1/recall --------------------------------
      if (path === '/mem/v1/recall' && request.method === 'POST') {
        const { handleRecall } = await import('./recall.js');
        return await dispatch(request, env, handleRecall);
      }
      if (path === '/mem/v1/full-recall' && request.method === 'POST') {
        const { handleFullRecall } = await import('./recall.js');
        return await dispatch(request, env, handleFullRecall);
      }

      // ----- Sync: POST /api/sync/upload ---------------------------------
      if (path === '/api/sync/upload' && request.method === 'POST') {
        const { handleSyncUpload } = await import('./sync.js');
        return await dispatch(request, env, handleSyncUpload);
      }
      if (path === '/api/sync/download' && request.method === 'POST') {
        const { handleSyncDownload } = await import('./sync.js');
        return await dispatch(request, env, handleSyncDownload);
      }
      if (path === '/api/sync/state' && request.method === 'GET') {
        const { handleSyncState } = await import('./sync.js');
        return await dispatch(request, env, handleSyncState);
      }
      if (path === '/api/sync/devices' && request.method === 'GET') {
        const { handleSyncDevices } = await import('./sync.js');
        return await dispatch(request, env, handleSyncDevices);
      }

      // ----- Everything else: static origin (GitHub Pages) --------------
      // Matches seele.agency's pre-existing behavior. Requests to the
      // root and unknown paths are served by the origin with cache-
      // busting headers so first-time visitors still get fresh content.
      return await handleFreshProxy(request, env, url);
    } catch (err) {
      return json(request, env, {
        ok: false,
        service: SERVICE,
        version: VERSION,
        error: 'internal_error',
        message: String((err && err.message) || err),
      }, 500);
    }
  },
};