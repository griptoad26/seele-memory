/**
 * src/index.js — seele-cloud Cloudflare Worker
 *
 * TASK-seele-cloud-20261019-092.
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
const VERSION = '0.1.0-phase1';

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
    phase: 1,
    environment: env.ENVIRONMENT || 'unknown',
    checks,
    // Contract per SPEC.md: "Status: { ok, version, last_reindex_at }"
    last_reindex_at: env.LAST_REINDEX_AT || null,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Placeholders for later phases — explicit 501 so callers know it's
// planned-but-unshipped rather than missing.
// ---------------------------------------------------------------------------

const PLANNED = {
  '/api/sync/devices': 'POST — register device under user_id (Phase 2)',
  '/api/sync/upload': 'POST — upload one encrypted envelope (Phase 2)',
  '/api/sync/download': 'GET — latest envelope for device (Phase 2)',
  '/api/sync/state': 'GET — user sync state, cursors (Phase 2)',
  '/mem/v1/recall': 'POST — top-K encrypted snippets via Vectorize (Phase 4)',
  '/mem/v1/full-recall': 'POST — full decrypted payloads w/ grant JWT (Phase 4)',
  '/api/keys/{user_id}/register': 'POST — first-time key registration (Phase 2)',
  '/api/keys/{user_id}/recover': 'POST — re-derive from BIP-39 (Phase 2)',
  '/api/bots': 'POST — create bot w/ scoped keypair (Phase 4)',
};

function handlePlanned(request, env, path) {
  const route = Object.keys(PLANNED).find((k) => {
    const stem = k
      .replace('{user_id}', '')
      .replace('{bot_id}', '');
    return path === k || path.startsWith(stem);
  });
  return json(
    request,
    env,
    {
      error: 'not_implemented',
      phase: 1,
      path,
      planned: route ? PLANNED[route] : null,
      message:
        'seele-cloud is at Phase 1. See SPEC.md for the phased rollout.',
    },
    501
  );
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

    try {
      // --- Health (Phase 1 acceptance criterion) ---
      if (path === '/api/mem/health' || path === '/health') {
        return await handleHealth(request, env);
      }

      // --- seele-fresh co-resident proxy (explicit mount) ---
      if (path === '/fresh' || path.startsWith('/fresh/')) {
        return await handleFreshProxy(request, env, url);
      }

      // --- Planned API surface (501 with the phase roadmap) ---
      if (
        path.startsWith('/api/sync/') ||
        path.startsWith('/mem/v1/') ||
        path.startsWith('/api/keys/') ||
        path.startsWith('/api/bots')
      ) {
        return handlePlanned(request, env, path);
      }

      // --- Everything else: static origin (GitHub Pages) ---
      // Matches seele.agency's pre-existing behavior. Requests to the
      // root and unknown paths are served by the origin with cache-
      // busting headers so first-time visitors still get fresh content.
      return await handleFreshProxy(request, env, url);
    } catch (err) {
      return json(
        request,
        env,
        {
          ok: false,
          service: SERVICE,
          version: VERSION,
          error: 'internal_error',
          message: String((err && err.message) || err),
        },
        500
      );
    }
  },
};
