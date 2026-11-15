#!/usr/bin/env node
/**
 * Multi-device end-to-end sync test for the seele-cloud path.
 *
 * Proves that envelopes uploaded from DEVICE A and DEVICE B are visible
 * to DEVICE C over the real HTTP API (not a mock), with the real auth
 * chain, and that the server-side conversation/message rows are correct.
 *
 * Usage:
 *   node test/e2e_multidevice_sync.mjs \
 *     --base https://seele-memory.griptoad.workers.dev \
 *     --devices 3
 *
 * Exits 0 on success, 1 on any failed assertion.
 */
import { createHash } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = String(args.base || 'https://seele-memory.griptoad.workers.dev').replace(/\/$/, '');
const N_DEVICES = Number(args.devices || 3);
const RUN_ID = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER_ID = args.user_id || `e2e-multidevice-${RUN_ID}`;

let passed = 0, failed = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── crypto helpers ─────────────────────────────────────────────────────────
// The server stores `*_encrypted` fields as opaque bytes; it never decrypts
// them. For an E2E *transport* test we therefore only need well-formed,
// distinct base64 payloads. We still derive a deterministic value per field
// so the test can assert byte-for-byte round-trip through the server.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ── HTTP helper ────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', token = null, body = null, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

// ── device registration ────────────────────────────────────────────────────
// The live worker derives user_id from the Cloudflare Access identity
// header. On the current (pre-fix) deployment it still honours a
// caller-supplied user_id, which is what lets several emulators share one
// tenant. We pass the header anyway: on a FIXED deployment the server
// derives the tenant from it and ignores the body — so this test works
// against both revisions.
async function registerDevice(deviceId, label) {
  const body = {
    user_id: USER_ID,
    device_id: deviceId,
    device: {
      device_id: deviceId,
      name: label,
      platform: 'android',
      app_version: '1.0.0',
    },
  };
  return api('/api/keys/register', {
    method: 'POST',
    body,
    headers: { 'cf-access-authenticated-user-email': `${USER_ID}@e2e.test` },
  });
}

// ── envelope construction ─────────────────────────────────────────────────
function makeEnvelope(deviceId, convoId, msgs) {
  return {
    device_id: deviceId,
    conversation: {
      conversation_id: convoId,
      llm_kind: 'chatgpt',
      title_encrypted: b64(`title:${convoId}`),
      source_url_encrypted: b64(`https://example.invalid/${convoId}`),
    },
    chunks: msgs.map((m, i) => ({
      chunk_id: `${convoId}-chunk-${i}`,
      client_msg_id: m.client_msg_id,
      body_encrypted: b64(m.body),
      // 384-dim bge-small-en-v1.5 shape, unit-norm-ish, CLS-pooled on the
      // Rust side. The server does not interpret the vector, but sending a
      // correctly-shaped one keeps the test honest about the payload.
      embedding: new Array(384).fill(0).map((_, k) => (k % 17) / 100),
    })),
  };
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`Base URL      : ${BASE}`);
console.log(`Devices       : ${N_DEVICES}`);
console.log(`Run id        : ${RUN_ID}`);
console.log(`User / tenant : ${USER_ID}`);

section('1. Device registration (each device gets its own bearer token)');
const devices = [];
for (let i = 0; i < N_DEVICES; i++) {
  const id = `dev-${i}-${RUN_ID}`;
  const r = await registerDevice(id, `E2E Device ${i}`);
  if (r.status !== 200 || !r.json?.device_token) {
    ok(`device ${i} registers`, false, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    continue;
  }
  devices.push({
    id,
    token: r.json.device_token,
    user_id: r.json.user_id,
    scope: r.json.scope,
    expires_at: r.json.expires_at,
  });
  ok(`device ${i} registers (${id})`, true);
  ok(`  └ token is a memory:write grant`, r.json.scope === 'memory:write', `scope=${r.json.scope}`);
}
ok(`all ${N_DEVICES} devices registered`, devices.length === N_DEVICES, `${devices.length}/${N_DEVICES}`);

if (devices.length === 0) {
  console.log('\nFATAL: no devices could register — cannot continue.');
  process.exit(1);
}

section('2. Tenant consistency — all devices resolve to the same user_id');
const uniqUsers = new Set(devices.map((d) => d.user_id));
ok('all devices share one tenant', uniqUsers.size === 1, `user_ids: ${[...uniqUsers].join(', ')}`);

section('3. Each device uploads its own conversations');
const uploads = [];
for (const d of devices) {
  const convoId = `convo-${d.id}`;
  const msgs = [
    { client_msg_id: `${d.id}-m1`, body: `hello from ${d.id} part one` },
    { client_msg_id: `${d.id}-m2`, body: `hello from ${d.id} part two` },
  ];
  const env = makeEnvelope(d.id, convoId, msgs);
  const r = await api('/api/sync/upload', { method: 'POST', token: d.token, body: env });
  ok(`${d.id} uploads 1 conversation / 2 chunks`, r.status === 200,
     `HTTP ${r.status} ${r.text.slice(0, 200)}`);
  uploads.push({ device: d, convoId, env, res: r });
}

section('4. Every device can download every other device\'s conversations');
for (const reader of devices) {
  const r = await api('/api/sync/download', { method: 'POST', token: reader.token, body: {} });
  ok(`${reader.id} downloads (HTTP 200)`, r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const envs = r.json?.envelopes || [];
  ok(`  └ got ${envs.length} envelope(s)`, envs.length >= N_DEVICES, `expected >= ${N_DEVICES}`);

  const seenConvos = new Set(
    envs.map((e) => e?.conversation?.conversation_id || e?.conversation_id).filter(Boolean)
  );
  let missing = [];
  for (const u of uploads) {
    if (!seenConvos.has(u.convoId)) missing.push(u.convoId);
  }
  ok(`  └ sees all ${uploads.length} uploaded conversations`, missing.length === 0,
     `missing: ${missing.join(', ')}`);

  // Cross-device payload integrity: the body a peer uploaded must come
  // back byte-identical (server stores opaque bytes).
  const byConvo = new Map(
    envs.map((e) => [e?.conversation?.conversation_id || e?.conversation_id, e])
  );
  let corrupt = [];
  for (const u of uploads) {
    const got = byConvo.get(u.convoId);
    if (!got) continue;
    const want = u.env.chunks.map((c) => c.body_encrypted).sort();
    const have = (got.chunks || []).map((c) => c.body_encrypted).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) corrupt.push(u.convoId);
  }
  ok('  └ payload bytes round-trip intact', corrupt.length === 0, `corrupt: ${corrupt.join(', ')}`);
}

section('5. Per-device provenance — server keeps each device\'s own conversations');
for (const d of devices) {
  const r = await api('/api/sync/download', { method: 'POST', token: d.token, body: {} });
  const envs = r.json?.envelopes || [];
  const own = envs.filter((e) => e?.device_id === d.id);
  ok(`${d.id} has its own uploaded conversation(s)`, own.length >= 1, `own=${own.length}`);
  const deviceIds = new Set(envs.map((e) => e?.device_id).filter(Boolean));
  ok(`  └ and sees conversations from ${deviceIds.size} distinct device(s)`,
     deviceIds.size === N_DEVICES, `saw: ${[...deviceIds].join(', ')}`);
}

section('6. Server state endpoint reflects the synced devices');
{
  const r = await api('/api/sync/state', { token: devices[0].token });
  ok('GET /api/sync/state returns 200', r.status === 200, `HTTP ${r.status}`);
  // /api/sync/state is PER-DEVICE by design: it defaults to the token's
  // own bot_id and returns that device's sync cursor. It is not a
  // device listing — /api/sync/devices is. Assert the per-device
  // contract: the response identifies the calling device and carries a
  // cursor.
  const st = r.json || {};
  ok(
    '  └ identifies the calling device',
    st.device_id === devices[0].id,
    `device_id=${st.device_id} expected ${devices[0].id}`
  );
  ok(
    '  └ carries the sync cursor',
    Number.isFinite(st.next_cursor ?? st.cursor ?? st.last_synced_at),
    `cursor=${st.next_cursor ?? st.cursor ?? st.last_synced_at}`
  );
}

section('7. Device registry lists all devices');
{
  const r = await api('/api/sync/devices', { token: devices[0].token });
  ok('GET /api/sync/devices returns 200', r.status === 200, `HTTP ${r.status}`);
  const list = r.json?.devices || [];
  const ids = new Set(list.map((x) => x.device_id));
  const missing = devices.filter((d) => !ids.has(d.id)).map((d) => d.id);
  ok(`  └ registry lists all ${N_DEVICES} devices`, missing.length === 0, `missing: ${missing.join(', ')}`);
}

section('8. Negative controls — the path is actually authenticated');
{
  const r = await api('/api/sync/download', { method: 'POST', body: {} });
  ok('download without a token is rejected', r.status === 401, `HTTP ${r.status}`);
  const r2 = await api('/api/sync/upload', { method: 'POST', token: 'not-a-real-token', body: {} });
  ok('upload with a bogus token is rejected', r2.status === 401, `HTTP ${r2.status}`);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`E2E MULTI-DEVICE SYNC — ${passed} passed, ${failed} failed`);
console.log(`tenant: ${USER_ID}`);
console.log(`${'='.repeat(60)}`);
process.exit(failed === 0 ? 0 : 1);
