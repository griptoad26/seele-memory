/**
 * test/sync.test.js — Sync envelope upload + dedupe + download.
 *
 * Covers:
 *   * valid upload inserts conversations + chunks
 *   * re-uploading the SAME envelope produces zero new chunks (idempotent)
 *   * Vectorize gets upserted once per chunk (not on dedupe)
 *   * Vectorize upsert failures don't block the upload (warning returned)
 *   * download returns chunks scoped to the caller
 *   * state returns the cursor + counts
 *   * devices lists the registered device
 *
 * The endpoint tests invoke the handler functions directly with a fake env,
 * not via the Worker fetch entrypoint — keeps tests fast and avoids the
 * whole "spin up a Worker" overhead in vitest.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSyncUpload, handleSyncDownload, handleSyncState, handleSyncDevices } from '../src/sync.js';
import { loginAs, userIdFor } from './helpers.js';
import { signGrant, SCOPE_WRITE, SCOPE_RECALL } from '../src/auth.js';
import { FakeD1 } from './fake-d1.js';
import { FakeVectorize } from './fake-vectorize.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567890abcdef';

function makeEnv() {
  return {
    DB: new FakeD1(),
    VECTORIZE: new FakeVectorize({ dimensions: 384 }),
    GRANT_JWT: SECRET,
  };
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function registerDevice(env, user_id, device_id) {
  // Identity derives from the Access email, not from user_id. The
  // returned token's sub is sha256('<user_id>@example.com').
  const r = await loginAs(env, `${user_id}@example.com`, device_id);
  return r.token;
}

async function makeAuthedRequest(url, method, token, body) {
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

function validEnvelope() {
  // embedding_vector is 384 dims — required so Vectorize gets an upsert.
  const v = new Array(384).fill(0).map((_, i) => Math.sin(i));
  return {
    device_id: 'd1',
    from_device_id: 'd1',
    conversation: {
      conversation_id: 'c1',
      llm_kind: 'claude',
      title_encrypted: b64(new TextEncoder().encode('title-bytes')),
    },
    chunks: [
      {
        chunk_id: 'chunk-aaa',
        client_msg_id: 'msg-001',
        body_encrypted: b64(new TextEncoder().encode('hello world plaintext')),
        embedding: b64(new TextEncoder().encode('embedding-bytes-blob')),
        embedding_vector: v,
      },
    ],
  };
}

describe('POST /api/sync/upload', () => {
  it('inserts a conversation + chunks + vector', async () => {
    const env = makeEnv();
    const token = await registerDevice(env, 'u1', 'd1');

    const req = await makeAuthedRequest('/api/sync/upload', 'POST', token, validEnvelope());
    const r = await handleSyncUpload(req, env);

    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(true);
    expect(r.body.conversation_id).toBe('c1');
    expect(r.body.chunks_inserted).toBe(1);
    expect(r.body.chunks_deduped).toBe(0);
    expect(r.body.chunks_indexed).toBe(1);
    expect(env.VECTORIZE.size()).toBe(1);
  });

  it('is idempotent on (user_id, conversation_id, client_msg_id)', async () => {
    const env = makeEnv();
    const token = await registerDevice(env, 'u1', 'd1');
    const env1 = validEnvelope();

    const r1 = await handleSyncUpload(
      await makeAuthedRequest('/api/sync/upload', 'POST', token, env1),
      env,
    );
    expect(r1.status).toBe(200);
    expect(r1.body.chunks_inserted).toBe(1);
    expect(r1.body.chunks_deduped).toBe(0);

    // Same envelope, same client_msg_id → no new chunks.
    const r2 = await handleSyncUpload(
      await makeAuthedRequest('/api/sync/upload', 'POST', token, env1),
      env,
    );
    expect(r2.status).toBe(200);
    expect(r2.body.chunks_inserted).toBe(0);
    expect(r2.body.chunks_deduped).toBe(1);
    expect(r2.body.chunks_indexed).toBe(0); // no re-upsert

    // Vectorize still has exactly one vector — the dedupe row is reused.
    expect(env.VECTORIZE.size()).toBe(1);
  });

  it('rejects requests missing a Bearer token', async () => {
    const env = makeEnv();
    const req = new Request('https://test/api/sync/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validEnvelope()),
    });
    const r = await handleSyncUpload(req, env);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('missing_bearer');
  });

  it('rejects malformed envelopes with a 400', async () => {
    const env = makeEnv();
    const token = await registerDevice(env, 'u1', 'd1');
    const req = await makeAuthedRequest('/api/sync/upload', 'POST', token, {
      device_id: 'd1',
      // missing conversation
      chunks: [],
    });
    const r = await handleSyncUpload(req, env);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_request');
  });

  it('survives Vectorize failures with a warning (D1 still updated)', async () => {
    const env = makeEnv();
    // Make Vectorize explode on upsert.
    env.VECTORIZE.upsert = async () => {
      throw new Error('vectorize is sad');
    };
    const token = await registerDevice(env, 'u1', 'd1');

    const r = await handleSyncUpload(
      await makeAuthedRequest('/api/sync/upload', 'POST', token, validEnvelope()),
      env,
    );
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(true);
    expect(r.body.chunks_inserted).toBe(1);
    expect(r.body.chunks_indexed).toBe(0);
    expect(r.body.warning).toMatch(/vectorize/);
  });
});

describe('POST /api/sync/download', () => {
  it('returns chunks for the caller and excludes other users', async () => {
    const env = makeEnv();

    // Two users, each uploads one chunk.
    const tA = await registerDevice(env, 'alice', 'd-alice');
    const tB = await registerDevice(env, 'bob', 'd-bob');

    const aEnv = validEnvelope();
    await handleSyncUpload(
      await makeAuthedRequest('/api/sync/upload', 'POST', tA, aEnv),
      env,
    );
    const bEnv = {
      ...validEnvelope(),
      device_id: 'd-bob',
      conversation: { conversation_id: 'c-bob', llm_kind: 'claude' },
      chunks: [
        {
          chunk_id: 'chunk-bob',
          client_msg_id: 'm1',
          body_encrypted: b64(new TextEncoder().encode('bob data')),
          embedding: b64(new TextEncoder().encode('emb')),
          embedding_vector: new Array(384).fill(0).map((_, i) => Math.cos(i)),
        },
      ],
    };
    await handleSyncUpload(
      await makeAuthedRequest('/api/sync/upload', 'POST', tB, bEnv),
      env,
    );

    // Alice downloads — only her chunk.
    const dl = await handleSyncDownload(
      await makeAuthedRequest('/api/sync/download', 'POST', tA, { since: 0 }),
      env,
    );
    expect(dl.status).toBe(200);
    expect(dl.body.envelopes.length).toBe(1);
    expect(dl.body.envelopes[0].conversation_id).toBe('c1');
    expect(dl.body.envelopes[0].chunks.length).toBe(1);
    expect(dl.body.envelopes[0].chunks[0].chunk_id).toBe('chunk-aaa');
  });
});

describe('GET /api/sync/state', () => {
  it('reports cursor + counts for the caller', async () => {
    const env = makeEnv();
    const token = await registerDevice(env, 'u1', 'd1');
    await handleSyncUpload(
      await makeAuthedRequest('/api/sync/upload', 'POST', token, validEnvelope()),
      env,
    );

    const req = new Request('https://test/api/sync/state?device_id=d1', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await handleSyncState(req, env);
    expect(r.status).toBe(200);
    expect(r.body.user_id).toBe(await userIdFor('u1@example.com'));
    expect(r.body.device_id).toBe('d1');
    expect(r.body.conv_count).toBe(1);
    expect(r.body.chunk_count).toBe(1);
    expect(r.body.cursor).toBeGreaterThan(0);
  });
});

describe('GET /api/sync/devices', () => {
  it('lists devices for the caller', async () => {
    const env = makeEnv();
    const token = await registerDevice(env, 'u1', 'd1');

    const req = new Request('https://test/api/sync/devices', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const r = await handleSyncDevices(req, env);
    expect(r.status).toBe(200);
    expect(r.body.devices.length).toBe(1);
    expect(r.body.devices[0].device_id).toBe('d1');
    expect(r.body.devices[0].platform).toBe('linux');
  });
});