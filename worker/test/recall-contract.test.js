/**
 * test/recall-contract.test.js — CONTRACT TESTS for /mem/v1/recall
 * (TASK-seele-cloud-20261116-109).
 *
 * ============================================================================
 *  WHY THIS FILE EXISTS
 * ============================================================================
 *
 *  TASK-seele-cloud-20261114-105 (v1.0.0 API stability) defined the recall
 *  response contract. A contract that lives only in a doc comment is not a
 *  contract — it is a suggestion. This suite is the machine-checked
 *  version of that definition.
 *
 *  The failure mode this exists to catch: someone renames `body_encrypted`
 *  to `ciphertext` (or `chunk_id` to `id`, or `snippets` to `results`) in
 *  `src/recall.js`, the Worker still returns 200 with a plausible-looking
 *  body, every bot silently gets `undefined` for the field it needs, and
 *  the breakage is discovered in production — by a user, not by CI.
 *
 *  The defence is **exact key-set assertions**: `Object.keys()` compared
 *  against a frozen literal, with `toEqual` on a sorted key list. An
 *  added field fails just as loudly as a removed one, because the
 *  SDK's TypeScript interfaces would otherwise reject the extra key at
 *  compile time on the SDK side but silently accept it here.
 *
 *  Two independent implementations encode this contract:
 *     * worker/src/recall.js        → the server
 *     * sdk/typescript/src/recall.ts → `interface RecallSnippet`
 *  This suite locks down the server side. The SDK-side mirror is in
 *  sdk/typescript/test/recall.test.ts.
 *
 * ============================================================================
 *  ROUTE PATH — IMPORTANT
 * ============================================================================
 *
 *  The task brief names the route `/api/mem/v1/recall`. That path does
 *  not exist and never has. The Worker mounts recall at:
 *
 *      POST /mem/v1/recall
 *      POST /mem/v1/full-recall
 *
 *  while the *health* route is the one under `/api/mem/*`:
 *
 *      GET /api/mem/health
 *
 *  This is consistent across SPEC.md (line 128), the SDK client
 *  (`sdk/typescript/src/recall.ts` posts to '/mem/v1/recall'), the
 *  wrangler route table (`seele.agency/mem/*`), and `src/index.js`.
 *  The `/api/mem/*` prefix in the brief appears to conflate the health
 *  route with the recall route. We test the real, shipped route.
 *  See the "ROUTE PATH" note in the report.
 *
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { handleRecall, handleFullRecall } from '../src/recall.js';
import { loginAs } from './helpers.js';
import { FakeD1 } from './fake-d1.js';
import { FakeVectorize } from './fake-vectorize.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567890abcdef';

// ---------------------------------------------------------------------------
// THE CONTRACT — single source of truth for this file.
//
// If you change one of these literals, you have changed the public API
// and you need to:
//   1. bump the SDK version + update `RecallSnippet`/`RecallResponse`
//      in sdk/typescript/src/recall.ts, and
//   2. note the change in SPEC.md §"Recall endpoint".
// Do not edit these literals to make a failing test pass. That is the
// exact anti-pattern this file exists to prevent.
// ---------------------------------------------------------------------------

/** Exact top-level keys of a 200 recall response. */
const RESPONSE_KEYS = ['query_id', 'snippets'];

/** Exact keys of a single item in `snippets[]`. */
const SNIPPET_KEYS = [
  'body_encrypted',
  'chunk_id',
  'conversation_id',
  'created_at',
  'score',
];

/** Exact keys of a 200 full-recall response (note: `matches`, not `snippets`). */
const FULL_RESPONSE_KEYS = ['matches', 'query_id'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function makeEnv() {
  return {
    DB: new FakeD1(),
    VECTORIZE: new FakeVectorize({ dimensions: 384 }),
    GRANT_JWT: SECRET,
  };
}

/**
 * Register a device for an email and return the bearer token.
 * `loginAs` returns a richer object; the recall routes want the token.
 */
async function register(env, email, device_id) {
  const r = await loginAs(env, email, device_id);
  if (!r.token) throw new Error(`registration failed: ${JSON.stringify(r.body)}`);
  return r.token;
}

async function authReq(url, method, token, body) {
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(`https://test${url}`, init);
}

async function uploadChunk(env, token, conversation_id, chunk_id, client_msg_id, text, vector) {
  const env1 = {
    device_id: 'd1',
    conversation: { conversation_id, llm_kind: 'claude' },
    chunks: [{
      chunk_id,
      client_msg_id,
      body_encrypted: b64(new TextEncoder().encode(text)),
      embedding: b64(new TextEncoder().encode('emb-blob')),
      embedding_vector: vector,
    }],
  };
  const r = await handleSyncUploadHelper(env, token, env1);
  if (r.status !== 200) throw new Error(`upload failed: ${JSON.stringify(r)}`);
  return r;
}

async function handleSyncUploadHelper(env, token, payload) {
  const { handleSyncUpload } = await import('../src/sync.js');
  return await handleSyncUpload(
    await authReq('/api/sync/upload', 'POST', token, payload),
    env,
  );
}

// A deterministic, L2-normalized 384-dim vector.
function vVector(seed = 1) {
  const v = new Array(384).fill(0).map((_, i) => Math.sin((i + 1) * 0.3 * seed));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/**
 * Assert that `obj` has EXACTLY the keys in `expected` — no more, no fewer.
 * Order-insensitive, but strict about the *set*.
 */
function expectExactKeys(obj, expected, label) {
  expect(Object.keys(obj).sort(), `${label}: unexpected key set`).toEqual([...expected].sort());
}

describe('CONTRACT: POST /mem/v1/recall response shape', () => {
  // -------------------------------------------------------------------------
  // 1. Exact top-level keys.
  // -------------------------------------------------------------------------
  it('returns exactly { snippets, query_id } — no more, no fewer', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-1', 'm1', 'hello', vec);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vec, top_k: 5 }),
      env,
    );

    expect(r.status).toBe(200);
    expectExactKeys(r.body, RESPONSE_KEYS, 'recall response');
    expect(Array.isArray(r.body.snippets)).toBe(true);
    expect(typeof r.body.query_id).toBe('string');
    expect(r.body.query_id.length).toBeGreaterThan(0);
  });

  it('returns exactly { snippets, query_id } even when the result set is empty', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(200);
    expectExactKeys(r.body, RESPONSE_KEYS, 'recall response (empty)');
    expect(r.body.snippets).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. Exact shape of each result item.
  // -------------------------------------------------------------------------
  it('returns snippet items with exactly the five contract fields', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-1', 'm1', 'hello', vec);
    await uploadChunk(env, token, 'c-1', 'chunk-2', 'm2', 'world', vec);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vec, top_k: 5 }),
      env,
    );

    expect(r.status).toBe(200);
    expect(r.body.snippets.length).toBe(2);

    for (const s of r.body.snippets) {
      expectExactKeys(s, SNIPPET_KEYS, 'snippet');

      // Field types are part of the contract too.
      expect(s.chunk_id).toBeTypeOf('string');
      expect(s.chunk_id.length).toBeGreaterThan(0);
      expect(s.score).toBeTypeOf('number');
      expect(Number.isFinite(s.score)).toBe(true);
      expect(s.created_at).toBeTypeOf('number');
      expect(Number.isInteger(s.created_at)).toBe(true);
      expect(s.created_at).toBeGreaterThan(0);
      expect(s.body_encrypted).toBeTypeOf('string');
      expect(s.body_encrypted.length).toBeGreaterThan(0);
      // conversation_id is `string | null` per the contract.
      expect(s.conversation_id === null || typeof s.conversation_id === 'string').toBe(true);
    }
  });

  it('snippet field names are the documented ones (renaming a field breaks this)', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-1', 'm1', 'hello', vec);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vec }),
      env,
    );

    const s = r.body.snippets[0];
    // Explicit per-field assertions — a rename of ANY one of these fails.
    expect(s).toHaveProperty('chunk_id');
    expect(s).toHaveProperty('score');
    expect(s).toHaveProperty('conversation_id');
    expect(s).toHaveProperty('created_at');
    expect(s).toHaveProperty('body_encrypted');

    // ...and the near-miss names that a careless rename would produce.
    expect(s).not.toHaveProperty('id');
    expect(s).not.toHaveProperty('encrypted_chunk');
    expect(s).not.toHaveProperty('ciphertext');
    expect(s).not.toHaveProperty('source');
    expect(s).not.toHaveProperty('content');
    expect(s).not.toHaveProperty('text');
  });

  it('snippet field values are populated correctly (not just present)', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-conv-xyz', 'chunk-unique-id', 'm1', 'hello world', vec);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vec }),
      env,
    );

    const s = r.body.snippets[0];
    expect(s.chunk_id).toBe('chunk-unique-id');
    expect(s.conversation_id).toBe('c-conv-xyz');
    // The ciphertext must round-trip to what the client uploaded: the
    // server stores it as a blob and must re-emit it base64-encoded.
    expect(s.body_encrypted).toBe(b64(new TextEncoder().encode('hello world')));
    expect(s.score).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 3. Unknown query → empty list, not an error.
  // -------------------------------------------------------------------------
  it('returns an empty list (200) for a query that matches nothing', async () => {
    // The "no results" path in src/recall.js is `ranked.length === 0`,
    // i.e. Vectorize returned zero neighbours. There is no score
    // threshold — a match at any score is returned — so the honest
    // way to exercise "unknown query" is an index with no vectors.
    //
    // A user with chunks but an empty vector index is exactly the
    // "query matched nothing" situation: authenticated, valid request,
    // zero results.
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vVector(3) }),
      env,
    );

    expect(r.status).toBe(200);
    expect(r.body.error).toBeUndefined();
    expect(Array.isArray(r.body.snippets)).toBe(true);
    expect(r.body.snippets).toEqual([]);
    expectExactKeys(r.body, RESPONSE_KEYS, 'unknown-query response');
  });

  it('returns an empty list (not an error) when a stored chunk has no vector', async () => {
    // A chunk in D1 that was never indexed into Vectorize (e.g. an
    // upload where the Vectorize upsert failed). The query finds no
    // neighbours, so the response must be an empty list — not a 500
    // and not a half-populated result.
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');

    // Upload with the embedding but WITHOUT embedding_vector, so the
    // row lands in D1 and the vector index stays empty.
    const { handleSyncUpload } = await import('../src/sync.js');
    const payload = {
      device_id: 'd1',
      conversation: { conversation_id: 'c-1', llm_kind: 'claude' },
      chunks: [{
        chunk_id: 'chunk-unindexed',
        client_msg_id: 'm1',
        body_encrypted: b64(new TextEncoder().encode('data')),
        embedding: b64(new TextEncoder().encode('emb')),
      }],
    };
    const up = await handleSyncUpload(
      await authReq('/api/sync/upload', 'POST', token, payload),
      env,
    );
    expect(up.status).toBe(200);
    expect(env.VECTORIZE.size()).toBe(0);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(200);
    expect(r.body.snippets).toEqual([]);
    expectExactKeys(r.body, RESPONSE_KEYS, 'unindexed-chunk response');
  });

  it('returns an empty list rather than a 404/500 when the corpus is empty', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vVector(2) }),
      env,
    );

    expect(r.status).toBe(200);
    expect(r.body.snippets).toEqual([]);
    expect(r.body.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. Fail-closed behaviour: unauthenticated → 401, never a body.
  // -------------------------------------------------------------------------
  it('returns 401 for an unauthenticated recall request', async () => {
    const env = makeEnv();

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', null, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(401);
  });

  it('returns 401 and leaks no snippets when unauthenticated', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-1', 'm1', 'secret', vec);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', null, { query_vector: vec, top_k: 10 }),
      env,
    );

    expect(r.status).toBe(401);
    // Fail closed: no data fields present at all.
    expect(r.body.snippets).toBeUndefined();
    expect(r.body.query_id).toBeUndefined();
    expect(r.body.body_encrypted).toBeUndefined();
    // ...and a stable machine-readable error code.
    expect(r.body.error).toBeTypeOf('string');
    expect(r.body.message).toBeTypeOf('string');
  });

  it('returns 401 for a malformed Authorization header', async () => {
    const env = makeEnv();

    const cases = [
      'Bearer',
      'Bearer ',
      'Basic abc123',
      'not-a-token',
      'Bearer a.b.c',
    ];

    for (const header of cases) {
      const req = new Request('https://test/mem/v1/recall', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: header },
        body: JSON.stringify({ query_vector: vVector(1) }),
      });
      const r = await handleRecall(req, env);
      expect(r.status, `header: ${JSON.stringify(header)}`).toBe(401);
      expect(r.body.snippets).toBeUndefined();
    }
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const env = makeEnv();
    const { signGrant } = await import('../src/auth.js');
    const { jwt } = await signGrant({
      secret: 'a-completely-different-secret-0123456789abcdef',
      sub: 'alice',
      bot_id: 'd-a',
      scope: 'memory:recall',
    });

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', jwt, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(401);
    expect(r.body.snippets).toBeUndefined();
  });

  it('returns 401 for an expired token', async () => {
    const env = makeEnv();
    const { signGrant } = await import('../src/auth.js');
    const { jwt } = await signGrant({
      secret: SECRET,
      sub: 'alice',
      bot_id: 'd-a',
      scope: 'memory:recall',
      ttl_seconds: -60, // already expired
    });

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', jwt, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(401);
    expect(r.body.snippets).toBeUndefined();
  });

  it('returns 401 for a token missing required claims', async () => {
    const env = makeEnv();
    const { SignJWT } = await import('jose');
    // Validly signed by the right secret, but `bot_id` is missing.
    const secretKey = new TextEncoder().encode(SECRET);
    const jwt = await new SignJWT({ scope: 'memory:recall' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('alice')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(secretKey);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', jwt, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(401);
    expect(r.body.snippets).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Cross-cutting: the router-level 401 must hold for *every* protected
  //    route, and a malformed body must not be authenticated into.
  // -------------------------------------------------------------------------
  it('a 401 response never carries a snippet-shaped body', async () => {
    const env = makeEnv();
    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', null, { query_vector: vVector(1) }),
      env,
    );

    expect(r.status).toBe(401);
    // If a handler ever started returning `snippets` on the error path,
    // this assertion catches it.
    expect(r.body.snippets).toBeUndefined();
    expect(Object.keys(r.body).sort()).toEqual(['error', 'message']);
  });
});

describe('CONTRACT: POST /mem/v1/full-recall response shape', () => {
  it('returns exactly { matches, query_id }', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-with-foo', 'm1', 'foo', vec);

    const r = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', token, { query: 'foo' }),
      env,
    );

    expect(r.status).toBe(200);
    expectExactKeys(r.body, FULL_RESPONSE_KEYS, 'full-recall response');
    expect(Array.isArray(r.body.matches)).toBe(true);
    expect(typeof r.body.query_id).toBe('string');
  });

  it('full-recall matches use the same item shape as recall snippets', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-with-foo', 'm1', 'foo', vec);

    const r = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', token, { query: 'foo' }),
      env,
    );

    expect(r.body.matches.length).toBe(1);
    expectExactKeys(r.body.matches[0], SNIPPET_KEYS, 'full-recall match');
  });

  it('returns an empty list (200) for an unknown keyword', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-with-foo', 'm1', 'foo', vec);

    const r = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', token, { query: 'zzz-no-such-thing' }),
      env,
    );

    expect(r.status).toBe(200);
    expect(r.body.matches).toEqual([]);
    expectExactKeys(r.body, FULL_RESPONSE_KEYS, 'unknown-keyword response');
  });

  it('returns 401 for an unauthenticated full-recall request', async () => {
    const env = makeEnv();

    const r = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', null, { query: 'anything' }),
      env,
    );

    expect(r.status).toBe(401);
    expect(r.body.matches).toBeUndefined();
    expect(Object.keys(r.body).sort()).toEqual(['error', 'message']);
  });
});

describe('CONTRACT: recall and full-recall agree on the item shape', () => {
  it('the same corpus produces identical item keys on both routes', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice@example.com', 'd-a');
    const vec = vVector(1);
    await uploadChunk(env, token, 'c-1', 'chunk-with-foo', 'm1', 'foo', vec);

    const recall = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: vec }),
      env,
    );
    const full = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', token, { query: 'foo' }),
      env,
    );

    expect(recall.body.snippets.length).toBeGreaterThan(0);
    expect(full.body.matches.length).toBeGreaterThan(0);

    expect(Object.keys(recall.body.snippets[0]).sort())
      .toEqual(Object.keys(full.body.matches[0]).sort());
  });
});
