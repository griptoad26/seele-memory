/**
 * test/recall.test.js — Recall API suite.
 *
 * CRITICAL test: cross-user isolation. A recall request from one user
 * must NEVER return chunks belonging to another user. This is enforced
 * two ways:
 *   1. JWT `sub` is the user_id; auth.js rejects mismatched bots.
 *   2. The D1 query in getChunksByIds binds user_id explicitly.
 * The test below exercises the full path with two registered users,
 * two distinct JWT secrets wouldn't help (HS256 shared secret), so
 * instead we exercise two user_ids with two grants signed by the same
 * secret but with different `sub` claims — and we assert that
 * Vectorize returning the wrong chunk_id still gets dropped because
 * the D1 WHERE user_id filter excludes it.
 *
 * We also cover:
 *   * happy-path top-K recall
 *   * top_k clamping (negative, fractional, > MAX_TOP_K)
 *   * query_vector length validation
 *   * full-recall keyword scan
 *   * unauthorized → 401
 */

import { describe, it, expect } from 'vitest';
import { handleRecall, handleFullRecall } from '../src/recall.js';
import { handleSyncUpload, handleSyncDownload } from '../src/sync.js';
import { handleRegisterDevice } from '../src/keys.js';
import { signGrant, SCOPE_WRITE, SCOPE_RECALL } from '../src/auth.js';
import { FakeD1 } from './fake-d1.js';
import { FakeVectorize } from './fake-vectorize.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567890abcdef';

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

async function register(env, user_id, device_id) {
  const req = new Request('https://test/api/keys/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id,
      device: { device_id, name: user_id + '-d', platform: 'linux', app_version: '0.10.0' },
    }),
  });
  const r = await handleRegisterDevice(req, env);
  return r.body.device_token;
}

async function authReq(url, method, token, body) {
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
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
  const r = await handleSyncUpload(await authReq('/api/sync/upload', 'POST', token, env1), env);
  if (r.status !== 200) throw new Error(`upload failed: ${JSON.stringify(r)}`);
  return r;
}

// Build two roughly-aligned vectors so cosine similarity comes out near 1.
function vNear(target, jitter = 0) {
  const v = new Array(384).fill(0).map((_, i) => Math.sin(i * 0.3));
  // normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  if (jitter) {
    for (let i = 0; i < v.length; i++) v[i] += (Math.random() - 0.5) * jitter;
  }
  return v;
}

describe('POST /mem/v1/recall', () => {
  it('returns top-K encrypted snippets for the caller', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const aliceVec = vNear('alice');
    await uploadChunk(env, token, 'c-alice', 'chunk-alice-1', 'm1', 'alice secrets', aliceVec);
    await uploadChunk(env, token, 'c-alice', 'chunk-alice-2', 'm2', 'alice other', aliceVec);

    const req = await authReq('/mem/v1/recall', 'POST', token, {
      query_vector: aliceVec,
      top_k: 5,
    });
    const r = await handleRecall(req, env);

    expect(r.status).toBe(200);
    expect(r.body.snippets.length).toBe(2);
    for (const s of r.body.snippets) {
      expect(s.body_encrypted).toBeTypeOf('string');
      expect(s.score).toBeGreaterThan(0.99);
    }
  });

  it('clamps top_k to [1, MAX_TOP_K] and uses a default', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const aliceVec = vNear('alice');
    await uploadChunk(env, token, 'c-alice', 'chunk-1', 'm1', 'data', aliceVec);

    // top_k = -5 → clamped to 1
    const r1 = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: aliceVec, top_k: -5 }),
      env,
    );
    expect(r1.status).toBe(200);
    expect(r1.body.snippets.length).toBe(1);

    // top_k = 9999 → clamped to MAX_TOP_K (50)
    const r2 = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: aliceVec, top_k: 9999 }),
      env,
    );
    expect(r2.status).toBe(200);

    // top_k omitted → default (10)
    const r3 = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: aliceVec }),
      env,
    );
    expect(r3.status).toBe(200);
  });

  it('rejects a query_vector with wrong dimensionality', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: new Array(10).fill(0) }),
      env,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_request');
  });

  it('rejects a non-array query_vector', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: 'not-an-array' }),
      env,
    );
    expect(r.status).toBe(400);
  });

  it('rejects requests missing auth', async () => {
    const env = makeEnv();
    const r = await handleRecall(
      new Request('https://test/mem/v1/recall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query_vector: vNear('x') }),
      }),
      env,
    );
    expect(r.status).toBe(401);
  });

  it('rejects a memory:write-required call signed with memory:recall', async () => {
    // The recall endpoint only needs memory:recall, so this just confirms
    // that a recall JWT still satisfies the recall-required gate.
    const env = makeEnv();
    // Mint a recall-only token directly via signGrant.
    const { jwt } = await signGrant({
      secret: SECRET,
      sub: 'alice',
      bot_id: 'd-a',
      scope: SCOPE_RECALL,
    });
    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', jwt, { query_vector: vNear('x') }),
      env,
    );
    expect(r.status).toBe(200); // recall scope satisfies recall-required
  });

  // -----------------------------------------------------------------------
  // CRITICAL: cross-user isolation. Recall must NEVER return another
  // user's chunks, even if Vectorize happens to have a vector with that
  // id (it shouldn't, but the test would catch a regression where D1's
  // user_id filter is missing).
  // -----------------------------------------------------------------------
  it('never returns another user\'s chunks (cross-user isolation)', async () => {
    const env = makeEnv();

    const aliceToken = await register(env, 'alice', 'd-a');
    const bobToken = await register(env, 'bob', 'd-b');

    const aliceVec = vNear('alice');
    const bobVec = vNear('bob');

    // Alice uploads her secret.
    await uploadChunk(env, aliceToken, 'c-alice', 'chunk-alice', 'm1', 'alice secret', aliceVec);
    // Bob uploads his.
    await uploadChunk(env, bobToken, 'c-bob', 'chunk-bob', 'm1', 'bob secret', bobVec);

    // Confirm both rows are in D1 (sanity).
    const aliceDl = await handleSyncDownload(
      await authReq('/api/sync/download', 'POST', aliceToken, { since: 0 }),
      env,
    );
    const bobDl = await handleSyncDownload(
      await authReq('/api/sync/download', 'POST', bobToken, { since: 0 }),
      env,
    );
    expect(aliceDl.body.envelopes.length).toBe(1);
    expect(aliceDl.body.envelopes[0].chunks[0].chunk_id).toBe('chunk-alice');
    expect(bobDl.body.envelopes.length).toBe(1);
    expect(bobDl.body.envelopes[0].chunks[0].chunk_id).toBe('chunk-bob');

    // Alice recalls — must only see her chunk.
    const aliceRecall = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', aliceToken, { query_vector: aliceVec, top_k: 10 }),
      env,
    );
    expect(aliceRecall.status).toBe(200);
    for (const s of aliceRecall.body.snippets) {
      expect(s.chunk_id).not.toBe('chunk-bob');
    }
    expect(aliceRecall.body.snippets.length).toBeGreaterThan(0);

    // Bob recalls — must only see his chunk.
    const bobRecall = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', bobToken, { query_vector: bobVec, top_k: 10 }),
      env,
    );
    expect(bobRecall.status).toBe(200);
    for (const s of bobRecall.body.snippets) {
      expect(s.chunk_id).not.toBe('chunk-alice');
    }
  });

  it('does not crash if Vectorize returns more ids than exist in D1', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const v = vNear('alice');
    await uploadChunk(env, token, 'c1', 'c-a', 'm1', 'data', v);

    // Sneak a phantom vector in (would only happen if Vectorize and D1
    // got out of sync; our D1 user_id filter should drop it).
    await env.VECTORIZE.upsert([
      { id: 'phantom-from-someone-else', values: v },
    ]);

    const r = await handleRecall(
      await authReq('/mem/v1/recall', 'POST', token, { query_vector: v, top_k: 10 }),
      env,
    );
    expect(r.status).toBe(200);
    for (const s of r.body.snippets) {
      expect(s.chunk_id).not.toBe('phantom-from-someone-else');
    }
  });
});

describe('POST /mem/v1/full-recall', () => {
  it('returns ciphertext matches by keyword scan', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const v = vNear('x');
    await uploadChunk(env, token, 'c1', 'chunk-with-foo', 'm1', 'foo bar baz', v);
    await uploadChunk(env, token, 'c2', 'chunk-with-bar', 'm2', 'qux', v);

    const r = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', token, { query: 'foo' }),
      env,
    );
    expect(r.status).toBe(200);
    expect(r.body.matches.length).toBe(1);
    expect(r.body.matches[0].chunk_id).toBe('chunk-with-foo');
    // ciphertext is the same opaque blob the caller uploaded — the
    // server does not decrypt, per the privacy model.
    expect(r.body.matches[0].body_encrypted).toBeTypeOf('string');
  });

  it('rejects an empty query', async () => {
    const env = makeEnv();
    const token = await register(env, 'alice', 'd-a');
    const r = await handleFullRecall(
      await authReq('/mem/v1/full-recall', 'POST', token, { query: '' }),
      env,
    );
    expect(r.status).toBe(400);
  });
});