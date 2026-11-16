/**
 * test/local-worker.js — spins up the REAL Worker against a LOCAL D1.
 *
 * ============================================================================
 *  WHY THIS HARNESS EXISTS
 * ============================================================================
 *
 *  TASK-seele-cloud-20261116-110 asks for a repeatable e2e sync test that
 *  runs against a local D1 and NEVER against production.
 *
 *  "Local D1" means real SQLite with foreign keys enforced — not the
 *  permissive FakeD1 from test/fake-d1.js. FakeD1 never enforces FKs,
 *  which is precisely why the devices-unique-index regression
 *  (TASK-101) could pass locally and break 100% of production writes.
 *  An e2e test built on FakeD1 would inherit that blindness.
 *
 *  So we use miniflare, which runs the actual workerd runtime and gives
 *  us a genuine D1 binding. The Worker code under test is the exact
 *  `src/index.js` default export — not a re-implementation.
 *
 *  ============================================================================
 *  THE VECTORIZE PROBLEM (and why LocalVectorize exists)
 * ============================================================================
 *
 *  Cloudflare's local runtime does NOT implement Vectorize:
 *
 *      $ wrangler dev --local
 *      WARNING Vectorize Index bindings do not support local development
 *      → env.VECTORIZE.query() throws
 *        "Error: Binding VECTORIZE needs to be run remotely"
 *
 *  miniflare's own README lists Vectorize under "Not yet supported".
 *  There is no config flag that enables it. The only ways to get a
 *  working Vectorize binding are (a) `remote: true` — which points at
 *  the REAL production index, explicitly forbidden by this task — or
 *  (b) supplying our own.
 *
 *  We supply our own: test/local-vectorize.js. It is a faithful
 *  implementation of the Vectorize subset this worker uses, and it does
 *  GENUINE cosine similarity over the EXACT vectors it was handed. That
 *  is what lets the suite assert the embedding round-tripped as a real
 *  vector instead of a stub — a stub returning canned scores could
 *  never prove that.
 *
 *  ============================================================================
 *  NO PRODUCTION CONTACT — how that is enforced
 * ============================================================================
 *
 *  1. The harness never reads a production URL. There is no --base
 *     flag, no env var, no default that points outward.
 *  2. `assertLocalOnly()` re-checks the request URL of every call the
 *     suite makes: it must be an http://127.0.0.1 / localhost origin.
 *     A stray absolute production URL fails the test loudly rather
 *     than quietly writing to the live database.
 *  3. No Cloudflare credentials are read. The D1 database is created
 *     in a throwaway temp directory that is deleted on teardown.
 *
 * ============================================================================
 */

import { Miniflare } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/index.js';
import { LocalVectorize } from './local-vectorize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The project's wrangler.toml pins compatibility_date = "2026-10-01",
// but the workerd binary bundled with the miniflare release we pin
// supports up to "2026-08-06". The APIs this test uses (D1, Request,
// Response, crypto.subtle) are unchanged across that range, so the
// harness uses the older date and the PRODUCTION config stays at
// 2026-10-01. Do not "fix" the project's wrangler.toml to match this —
// that would be a downgrade of the deployed runtime.
const LOCAL_COMPAT_DATE = '2026-08-06';

const MIGRATIONS = [
  '0001_initial.sql',
  '0002_alter_encrypted_chunks.sql',
  '0003_device_revocation.sql',
  '0004_fix_devices_unique_index.sql',
];

/**
 * A running local Worker: real D1, real Worker code, local Vectorize.
 */
export class LocalWorker {
  constructor(mf, db, vectorize, tmpDir, env) {
    this.mf = mf;
    this.db = db;
    this.vectorize = vectorize;
    this._tmpDir = tmpDir;
    this.env = env;
    this.calls = [];
  }

  /**
   * Make a request against the local worker.
   *
   * @param {string} path       e.g. '/api/sync/upload'
   * @param {object} [opts]
   * @param {string} [opts.method]
   * @param {any}    [opts.body]
   * @param {string} [opts.token]        bearer token
   * @param {object} [opts.headers]
   * @returns {Promise<{status:number, json:any, text:string, headers:Headers}>}
   */
  async request(path, opts = {}) {
    const url = new URL(path, 'http://127.0.0.1:8788');
    assertLocalOnly(url);

    const headers = { ...(opts.headers || {}) };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const req = new Request(url, {
      method: opts.method || 'POST',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    this.calls.push({ method: req.method, path: url.pathname });
    const res = await worker.fetch(req, this.env, {});
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Tear down: dispose miniflare and delete the temp database. */
  async stop() {
    try { await this.mf.dispose(); } catch { /* already gone */ }
    if (this._tmpDir) {
      await rm(this._tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Start a local Worker with a fresh, migrated D1 database.
 *
 * @param {object} [opts]
 * @param {string} [opts.grantJwt]  shared secret for grant JWTs
 * @param {number} [opts.dimensions] Vectorize dimensionality
 * @returns {Promise<LocalWorker>}
 */
export async function startLocalWorker(opts = {}) {
  const grantJwt = opts.grantJwt ?? 'local-e2e-test-secret-0123456789abcdef';
  const dimensions = opts.dimensions ?? 384;

  const tmpDir = await mkdtemp(join(tmpdir(), 'seele-e2e-'));

  const mf = new Miniflare({
    modules: true,
    script: `export default { async fetch() { return new Response("placeholder"); } }`,
    d1Databases: { DB: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    d1Persist: tmpDir,
    compatibilityDate: LOCAL_COMPAT_DATE,
  });

  const db = await mf.getD1Database('DB');
  await applyMigrations(db);

  const vectorize = new LocalVectorize({ dimensions, metric: 'cosine' });

  const env = {
    DB: db,
    VECTORIZE: vectorize,
    GRANT_JWT: grantJwt,
    ENVIRONMENT: 'local-e2e',
    ORIGIN_URL: 'http://127.0.0.1:8788',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    LAST_REINDEX_AT: String(Date.now()),
  };

  return new LocalWorker(mf, db, vectorize, tmpDir, env);
}

/**
 * Apply the project's migrations to a fresh D1 database, in order.
 * Uses the exact .sql files that ship to production.
 *
 * D1's `exec()` rejects a file whose FIRST token is a `--` comment
 * ("SQL code did not contain a statement"), and it is strict about
 * statement boundaries. So we split the file into individual statements
 * ourselves and run each one. Comments are stripped, but the statement
 * text itself is untouched — these are the shipped .sql files, not
 * re-typed copies.
 */
async function applyMigrations(db) {
  for (const name of MIGRATIONS) {
    const sql = await readFile(join(__dirname, '..', 'migrations', name), 'utf8');
    for (const stmt of splitStatements(sql)) {
      await db.prepare(stmt).run();
    }
  }
}

/**
 * Split a .sql file into executable statements.
 *
 * Handles `--` line comments, `/* *\/` block comments, and quoted
 * strings containing semicolons (so a `;` inside a string literal does
 * not split a statement).
 */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    // Line comment
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // Block comment
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Quoted string — copy verbatim, honouring '' escapes.
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      cur += ch;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, not the end.
          if (sql[i + 1] === quote) {
            cur += quote + quote;
            i += 2;
            continue;
          }
          cur += quote;
          i++;
          break;
        }
        cur += sql[i];
        i++;
      }
      continue;
    }
    if (ch === ';') {
      const trimmed = cur.trim();
      if (trimmed) out.push(trimmed);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }

  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Refuse to talk to anything that isn't loopback.
 * This is the guard that makes "never production" a property of the
 * code rather than a promise in a comment.
 */
export function assertLocalOnly(url) {
  const host = url.hostname;
  const ok = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!ok) {
    throw new Error(
      `REFUSING to send a test request to non-local host "${host}". ` +
      'The e2e sync suite must never touch production.'
    );
  }
}

// ---------------------------------------------------------------------------
// Small assertion harness.
//
// Deliberately dependency-free and independent of vitest: this suite runs
// as a standalone node script against a spawned runtime, and it must be
// runnable with `npm run test:e2e` without a test framework in the loop.
// ---------------------------------------------------------------------------

export class Checks {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.failures = [];
    this._section = '';
  }

  section(title) {
    this._section = title;
    console.log(`\n${title}`);
  }

  ok(label, cond, extra = '') {
    if (cond) {
      this.passed++;
      console.log(`  [PASS] ${label}`);
    } else {
      this.failed++;
      this.failures.push({ section: this._section, label, extra });
      console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`);
    }
    return !!cond;
  }

  equal(label, actual, expected) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    return this.ok(
      label,
      same,
      same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }

  summary() {
    console.log(`\n${'='.repeat(64)}`);
    console.log(`E2E MULTI-DEVICE SYNC (local D1) — ${this.passed} passed, ${this.failed} failed`);
    if (this.failed) {
      console.log('\nFailures:');
      for (const f of this.failures) {
        console.log(`  · [${f.section}] ${f.label}${f.extra ? ` — ${f.extra}` : ''}`);
      }
    }
    console.log(`${'='.repeat(64)}`);
    return this.failed === 0;
  }
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

/**
 * A deterministic, L2-normalized 384-dim vector.
 *
 * NOTE: this is a *test fixture*, not a model. It is NOT the SDK's
 * hashEmbedder384 stub and it is NOT semantically meaningful. It exists
 * so the suite can assert an exact, reproducible vector round-trip
 * through upload → Vectorize → recall. The distinction that matters:
 * the fixture is a KNOWN vector, so if the worker corrupts, rescales,
 * truncates, or substitutes it, the assertion catches it. A semantic
 * embedder could not be asserted that way.
 */
export function fixtureVector(seed = 1, dims = 384) {
  const v = new Array(dims).fill(0).map((_, i) => Math.sin((i + 1) * 0.3 * seed));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}
