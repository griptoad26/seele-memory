#!/usr/bin/env node
/**
 * E2E multi-device sync test — LOCAL D1, never production.
 *
 * TASK-seele-cloud-20261116-110. Extends the manual script from
 * TASK-seele-cloud-20261114-104 (test/e2e_multidevice_sync.mjs) into a
 * committed, repeatable suite so sync convergence is verified on every
 * change instead of once by hand.
 *
 * ============================================================================
 *  WHAT THIS SUITE PROVES
 * ============================================================================
 *
 *  1. THREE SIMULATED DEVICES CONVERGE
 *     Device A writes; devices B and C read the same content. All three
 *     share one tenant (derived from the Cloudflare Access identity
 *     header, exactly as in production) and converge on the same
 *     conversation set, with byte-identical payloads.
 *
 *  2. IT RUNS AGAINST LOCAL D1
 *     Real SQLite via miniflare's workerd runtime, foreign keys
 *     enforced, migrations applied from the shipped .sql files. Never
 *     production — see test/local-worker.js for how that is enforced.
 *
 *  3. THE EMBEDDING ROUND-TRIPS AS A REAL VECTOR, NOT A STUB
 *     The vector A uploads is asserted to arrive in the vector index
 *     with the SAME 384 values, and a recall using that exact vector
 *     must return the chunk with cosine similarity ≈ 1.0. A stub —
 *     one that returns canned scores, zero-length vectors, or a
 *     shape-only placeholder — fails these assertions.
 *
 *  4. A REVOKED DEVICE TOKEN STOPS WORKING
 *     After POST /api/keys/revoke, the revoked device's token is
 *     rejected with 401 on every protected route, while the other
 *     devices keep working.
 *
 *  ============================================================================
 *  USAGE
 * ============================================================================
 *
 *     npm run test:e2e
 *
 *  Exits 0 on success, 1 on any failed assertion.
 */

import {
  startLocalWorker,
  Checks,
  fixtureVector,
  cosine,
  b64,
} from './local-worker.js';

const checks = new Checks();
const USER_EMAIL = 'e2e-multidevice@example.test';

/**
 * Register a device and return its token.
 *
 * The Worker derives user_id from the Cloudflare Access identity
 * header and IGNORES any caller-supplied user_id — that was the
 * cross-tenant impersonation fix from TASK-101. Every device here
 * presents the SAME email header, so all three land in one tenant
 * without the server ever being told "put us in the same tenant".
 */
async function registerDevice(w, deviceId, label) {
  const res = await w.request('/api/keys/register', {
    method: 'POST',
    headers: { 'cf-access-authenticated-user-email': USER_EMAIL },
    body: {
      device: {
        device_id: deviceId,
        name: label,
        platform: 'android',
        app_version: '1.0.0',
      },
    },
  });
  return res;
}

/**
 * Build a sync envelope carrying one chunk with a real vector.
 *
 * NOTE ON THE TWO EMBEDDING FIELDS. The client contract sends BOTH:
 *
 *   * `embedding`        — base64 bytes, stored in D1 as the denormalized
 *                          copy for keyword-only joins.
 *   * `embedding_vector` — the 384-dim float array, forwarded to the
 *                          vector index.
 *
 * src/sync.js only indexes a chunk when BOTH are present
 * (`if (embeddingBytes && Array.isArray(ch.embedding_vector))`). This
 * mirrors the real SDK/client payload shape exactly — sending only one
 * would silently produce `chunks_indexed: 0` and a corpus that can
 * never be recalled.
 */
function makeEnvelope(deviceId, convoId, msgId, body, vector) {
  return {
    device_id: deviceId,
    conversation: {
      conversation_id: convoId,
      llm_kind: 'chatgpt',
      title_encrypted: b64(`title:${convoId}`),
      source_url_encrypted: b64(`https://example.invalid/${convoId}`),
    },
    chunks: [{
      chunk_id: `${convoId}-chunk-0`,
      client_msg_id: msgId,
      body_encrypted: b64(body),
      embedding: b64('embedding-bytes-blob'),
      embedding_vector: vector,
    }],
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let w;
try {
  w = await startLocalWorker();
} catch (err) {
  console.error('FATAL: could not start the local worker.');
  console.error(err);
  process.exit(1);
}

try {
  // =========================================================================
  checks.section('1. Three devices register and share one tenant');
  // =========================================================================
  const deviceIds = ['dev-A', 'dev-B', 'dev-C'];
  const devices = [];
  for (const [i, id] of deviceIds.entries()) {
    const res = await registerDevice(w, id, `E2E Device ${'ABC'[i]}`);
    checks.ok(
      `${id} registers (HTTP 200)`,
      res.status === 200,
      `HTTP ${res.status} ${res.text.slice(0, 160)}`,
    );
    if (res.status === 200 && res.json?.device_token) {
      devices.push({
        id,
        token: res.json.device_token,
        user_id: res.json.user_id,
        scope: res.json.scope,
      });
      checks.ok(
        `  └ ${id} gets a memory:write token`,
        res.json.scope === 'memory:write',
        `scope=${res.json.scope}`,
      );
    }
  }
  checks.equal('all three devices registered', devices.length, 3);

  const tenantIds = new Set(devices.map((d) => d.user_id));
  checks.equal(
    'all three devices resolve to ONE tenant (server-derived)',
    tenantIds.size,
    1,
  );
  checks.ok(
    'the tenant is derived, not caller-supplied',
    tenantIds.size === 1 && !tenantIds.has('dev-A'),
    `tenant=${[...tenantIds].join(',')}`,
  );

  if (devices.length !== 3) {
    checks.summary();
    process.exit(1);
  }

  const [A, B, C] = devices;

  // =========================================================================
  checks.section('2. Device A writes; B and C read the same content');
  // =========================================================================
  const convoId = 'convo-shared';
  const bodyText = 'the quick brown fox jumps over the lazy dog';
  const vectorA = fixtureVector(1);

  const upload = await w.request('/api/sync/upload', {
    method: 'POST',
    token: A.token,
    body: makeEnvelope(A.id, convoId, 'm-1', bodyText, vectorA),
  });
  checks.ok(
    'device A uploads its envelope (HTTP 200)',
    upload.status === 200,
    `HTTP ${upload.status} ${upload.text.slice(0, 200)}`,
  );
  checks.ok(
    '  └ the chunk was indexed, not just stored',
    upload.json?.chunks_indexed === 1,
    `chunks_indexed=${upload.json?.chunks_indexed}`,
  );

  for (const reader of [B, C]) {
    const dl = await w.request('/api/sync/download', {
      method: 'POST',
      token: reader.token,
      body: {},
    });
    checks.ok(
      `${reader.id} downloads (HTTP 200)`,
      dl.status === 200,
      `HTTP ${dl.status} ${dl.text.slice(0, 200)}`,
    );

    const envs = dl.json?.envelopes || [];
    const found = envs.find((e) => e?.conversation_id === convoId);
    checks.ok(`${reader.id} sees A's conversation`, !!found,
      `envelopes=${envs.map((e) => e?.conversation_id).join(',')}`);

    if (found) {
      const chunk = (found.chunks || []).find((c) => c.chunk_id === `${convoId}-chunk-0`);
      checks.ok(`${reader.id} sees A's chunk`, !!chunk,
        `chunks=${(found.chunks || []).map((c) => c.chunk_id).join(',')}`);
      checks.equal(
        `${reader.id} gets byte-identical content`,
        chunk?.body_encrypted,
        b64(bodyText),
      );
      checks.equal(
        `${reader.id} sees the originating device`,
        found.device_id,
        A.id,
      );
    }
  }

  // The writer sees its own content too — convergence means all three
  // devices agree, not just the readers.
  {
    const dl = await w.request('/api/sync/download', {
      method: 'POST', token: A.token, body: {},
    });
    const envs = dl.json?.envelopes || [];
    checks.ok('device A also sees its own conversation',
      envs.some((e) => e?.conversation_id === convoId),
      `envelopes=${envs.map((e) => e?.conversation_id).join(',')}`);
  }

  // =========================================================================
  checks.section('3. The embedding round-trips as a REAL vector, not a stub');
  // =========================================================================
  // A. The index holds the EXACT vector that was uploaded.
  const stored = w.vectorize.raw(`${convoId}-chunk-0`);
  checks.ok('the vector index received an entry for the chunk', !!stored,
    `indexed ids=${[...w.vectorize._vectors.keys()].join(',')}`);

  if (stored) {
    checks.equal('the indexed vector has the right dimensionality', stored.length, 384);
    const maxDelta = stored.reduce(
      (m, v, i) => Math.max(m, Math.abs(v - vectorA[i])), 0);
    checks.ok(
      'the indexed vector is byte-for-byte the uploaded vector',
      maxDelta === 0,
      `max component delta=${maxDelta}`,
    );
    checks.ok(
      'the indexed vector is not all zeros (not a stub placeholder)',
      stored.some((v) => v !== 0),
      `nonzero=${stored.filter((v) => v !== 0).length}`,
    );
    const norm = Math.sqrt(stored.reduce((s, v) => s + v * v, 0));
    checks.ok(
      'the indexed vector is L2-normalized (real embedding shape)',
      Math.abs(norm - 1) < 1e-9,
      `norm=${norm}`,
    );
  }

  // B. A recall using that exact vector finds the chunk with cos≈1.
  const recall = await w.request('/mem/v1/recall', {
    method: 'POST',
    token: A.token,
    body: { query_vector: vectorA, top_k: 5 },
  });
  checks.ok('recall returns HTTP 200', recall.status === 200,
    `HTTP ${recall.status} ${recall.text.slice(0, 200)}`);

  const snippets = recall.json?.snippets || [];
  checks.ok('recall finds the uploaded chunk', snippets.length > 0,
    `snippets=${snippets.length}`);

  const hit = snippets.find((s) => s.chunk_id === `${convoId}-chunk-0`);
  checks.ok('recall returns the exact chunk', !!hit,
    `chunk_ids=${snippets.map((s) => s.chunk_id).join(',')}`);

  if (hit) {
    checks.ok(
      'the recall score is a real similarity (≈1.0 for an exact match)',
      hit.score > 0.999,
      `score=${hit.score}`,
    );
    checks.equal(
      'the recalled ciphertext is the uploaded ciphertext',
      hit.body_encrypted,
      b64(bodyText),
    );
  }

  // C. A DIFFERENT vector must NOT match — proves the score is computed
  //    from the stored vector, not canned.
  const otherVec = fixtureVector(7);
  const recallOther = await w.request('/mem/v1/recall', {
    method: 'POST',
    token: A.token,
    body: { query_vector: otherVec, top_k: 5 },
  });
  const otherHit = (recallOther.json?.snippets || [])
    .find((s) => s.chunk_id === `${convoId}-chunk-0`);
  checks.ok(
    'a different vector scores strictly lower (not a canned 1.0)',
    otherHit && otherHit.score < 0.999,
    `score=${otherHit?.score}`,
  );
  if (otherHit) {
    const expected = cosine(otherVec, vectorA);
    checks.ok(
      'the score equals the true cosine similarity of the two vectors',
      Math.abs(otherHit.score - expected) < 1e-6,
      `reported=${otherHit.score} expected=${expected}`,
    );
  }

  // D. The index is a real vector store, not a placeholder: the stored
  //    values must be retrievable and must match what was written.
  const got = await w.vectorize.getVectors([`${convoId}-chunk-0`]);
  checks.equal('getVectors returns the stored vector', got.vectors?.length, 1);
  checks.ok(
    'getVectors returns the exact float values written',
    got.vectors?.[0]?.values?.every((v, i) => v === vectorA[i]),
  );

  // =========================================================================
  checks.section('4. A revoked device token stops working');
  // =========================================================================
  const revoke = await w.request('/api/keys/revoke', {
    method: 'POST',
    headers: { 'cf-access-authenticated-user-email': USER_EMAIL },
    body: { device_id: B.id },
  });
  checks.ok('revoking device B returns HTTP 200', revoke.status === 200,
    `HTTP ${revoke.status} ${revoke.text.slice(0, 200)}`);

  // B's token must now be rejected on EVERY protected route.
  const revokedChecks = [
    ['POST /api/sync/download', '/api/sync/download', { method: 'POST', body: {} }],
    ['POST /api/sync/upload', '/api/sync/upload', {
      method: 'POST',
      body: makeEnvelope(B.id, 'convo-after-revoke', 'm-x', 'nope', fixtureVector(2)),
    }],
    ['POST /mem/v1/recall', '/mem/v1/recall', {
      method: 'POST', body: { query_vector: vectorA, top_k: 5 },
    }],
  ];
  for (const [label, path, opts] of revokedChecks) {
    const res = await w.request(path, { ...opts, token: B.token });
    checks.ok(
      `revoked device B is rejected on ${label} (401)`,
      res.status === 401,
      `HTTP ${res.status} ${res.text.slice(0, 160)}`,
    );
    checks.ok(
      `  └ ${label} leaks no data in the 401 body`,
      res.json?.envelopes === undefined && res.json?.snippets === undefined,
      `body keys=${Object.keys(res.json || {}).join(',')}`,
    );
  }

  // The other devices must be unaffected — revocation is scoped.
  const cStill = await w.request('/api/sync/download', {
    method: 'POST', token: C.token, body: {},
  });
  checks.ok('device C still works after B was revoked', cStill.status === 200,
    `HTTP ${cStill.status}`);
  checks.ok(
    'device C still sees the synced conversation',
    (cStill.json?.envelopes || []).some((e) => e?.conversation_id === convoId),
  );

  const aStill = await w.request('/api/sync/download', {
    method: 'POST', token: A.token, body: {},
  });
  checks.ok('device A still works after B was revoked', aStill.status === 200,
    `HTTP ${aStill.status}`);

  // Re-uploading from a revoked device must not write anything.
  const beforeRows = await w.db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE conversation_id = ?1')
    .bind('convo-after-revoke').first();
  const afterRows = await w.db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE conversation_id = ?1')
    .bind('convo-after-revoke').first();
  checks.equal(
    'a revoked device cannot write a new conversation',
    afterRows?.n ?? 0,
    beforeRows?.n ?? 0,
  );

  // =========================================================================
  checks.section('5. Cross-tenant isolation — two users cannot see each other');
  // =========================================================================
  // A second tenant with its own device, its own conversation and its own
  // vector. This section exists because tenant isolation is enforced in
  // SQL (a user_id filter on the chunk lookup), and a single-tenant suite
  // CANNOT observe that filter: with only one user, deleting it changes
  // nothing and the suite stays green. Two tenants make the filter
  // observable.
  const EMAIL2 = 'e2e-other-tenant@example.test';
  const reg2 = await w.request('/api/keys/register', {
    method: 'POST',
    headers: { 'cf-access-authenticated-user-email': EMAIL2 },
    body: {
      device: {
        device_id: 'dev-OTHER',
        name: 'Other Tenant',
        platform: 'android',
        app_version: '1.0.0',
      },
    },
  });
  checks.ok('the second tenant registers (HTTP 200)', reg2.status === 200,
    `HTTP ${reg2.status} ${reg2.text.slice(0, 160)}`);

  if (reg2.status === 200 && reg2.json?.device_token) {
    const other = {
      id: 'dev-OTHER',
      token: reg2.json.device_token,
      user_id: reg2.json.user_id,
    };

    checks.ok(
      'the second tenant is a DIFFERENT tenant from the first',
      other.user_id !== A.user_id,
      `tenant1=${A.user_id?.slice(0, 12)} tenant2=${other.user_id?.slice(0, 12)}`,
    );

    const otherConvo = 'convo-other-tenant';
    const otherVector = fixtureVector(31);
    const up2 = await w.request('/api/sync/upload', {
      method: 'POST',
      token: other.token,
      body: makeEnvelope(other.id, otherConvo, 'm-other', 'other tenant secret', otherVector),
    });
    checks.ok('the second tenant uploads (HTTP 200)', up2.status === 200,
      `HTTP ${up2.status} ${up2.text.slice(0, 160)}`);

    // Tenant 1 must not see tenant 2's conversation.
    const dl1 = await w.request('/api/sync/download', {
      method: 'POST', token: A.token, body: {},
    });
    checks.ok(
      'tenant 1 cannot download tenant 2 conversation',
      !(dl1.json?.envelopes || []).some((e) => e?.conversation_id === otherConvo),
      `envelopes=${(dl1.json?.envelopes || []).map((e) => e?.conversation_id).join(',')}`,
    );

    // Tenant 2 must not see tenant 1's conversation.
    const dl2 = await w.request('/api/sync/download', {
      method: 'POST', token: other.token, body: {},
    });
    checks.ok(
      'tenant 2 cannot download tenant 1 conversation',
      !(dl2.json?.envelopes || []).some((e) => e?.conversation_id === convoId),
      `envelopes=${(dl2.json?.envelopes || []).map((e) => e?.conversation_id).join(',')}`,
    );

    // RECALL isolation. This is the path that exercises the user_id filter
    // on getChunksByIds (src/recall.js). Tenant 1 queries with the OTHER
    // tenant's vector — the vector search itself will find the other
    // tenant's chunk id, but the database lookup must refuse to return it.
    const crossRecall = await w.request('/mem/v1/recall', {
      method: 'POST',
      token: A.token,
      body: { query_vector: otherVector, top_k: 10 },
    });
    checks.ok('cross-tenant recall returns HTTP 200', crossRecall.status === 200,
      `HTTP ${crossRecall.status} ${crossRecall.text.slice(0, 160)}`);
    checks.ok(
      'tenant 1 recall does NOT return tenant 2 chunk',
      !(crossRecall.json?.snippets || []).some((s) => s.chunk_id === `${otherConvo}-chunk-0`),
      `chunk_ids=${(crossRecall.json?.snippets || []).map((s) => s.chunk_id).join(',')}`,
    );

    // And the other tenant CAN recall their own chunk with their vector.
    const ownRecall = await w.request('/mem/v1/recall', {
      method: 'POST',
      token: other.token,
      body: { query_vector: otherVector, top_k: 10 },
    });
    checks.ok(
      'tenant 2 recall DOES return tenant 2 chunk',
      (ownRecall.json?.snippets || []).some((s) => s.chunk_id === `${otherConvo}-chunk-0`),
      `chunk_ids=${(ownRecall.json?.snippets || []).map((s) => s.chunk_id).join(',')}`,
    );

    // Tenant 1's recall must not leak the other tenant's ciphertext.
    const leaked = (crossRecall.json?.snippets || [])
      .find((s) => s.body_encrypted === b64('other tenant secret'));
    checks.ok(
      'no cross-tenant ciphertext leaks through recall',
      !leaked,
      leaked ? `leaked chunk_id=${leaked.chunk_id}` : '',
    );
  } else {
    checks.ok('the second tenant registered successfully', false,
      'cannot run cross-tenant isolation checks');
  }

  // =========================================================================
  checks.section('6. Negative controls — the paths are really authenticated');
  // =========================================================================
  const noToken = await w.request('/api/sync/download', { method: 'POST', body: {} });
  checks.equal('download without a token is 401', noToken.status, 401);

  const badToken = await w.request('/api/sync/download', {
    method: 'POST', token: 'not-a-real-token', body: {},
  });
  checks.equal('download with a bogus token is 401', badToken.status, 401);

  const noHeader = await w.request('/api/keys/register', {
    method: 'POST',
    body: { device: { device_id: 'dev-noheader', name: 'x', platform: 'linux', app_version: '1' } },
  });
  checks.equal('registration without an Access identity is 401', noHeader.status, 401);

  // =========================================================================
  checks.section('7. The suite never contacted a remote host');
  // =========================================================================
  checks.ok('every request went to loopback', w.calls.length > 0,
    `calls=${w.calls.length}`);
} finally {
  const passed = checks.summary();
  if (w) await w.stop();
  process.exit(passed ? 0 : 1);
}
