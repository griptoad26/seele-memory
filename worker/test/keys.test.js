/**
 * test/keys.test.js — the tests that would have caught TASK-...-101.
 *
 * Before this file existed, `POST /api/keys/register` took `user_id`
 * from the request body. Nothing tested the absence of the Access
 * header, nothing tested that a body claiming someone else's user_id
 * loses, and there was no revocation route to test at all.
 *
 * Each `it` below corresponds to a row in the task spec. They are
 * deliberately adversarial: they send the exact payloads an attacker
 * would send, including the well-formed device object that made the
 * original repro look like a legitimate client.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleRegisterDevice, handleRevokeDevice, userIdFromEmail } from '../src/keys.js';
import { verifyGrant, signGrant, SCOPE_WRITE } from '../src/auth.js';
import { handleSyncDevices, handleSyncUpload } from '../src/sync.js';
import { FakeD1 } from './fake-d1.js';
import { loginAs, userIdFor, authedReq } from './helpers.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567890abcdef';

function makeEnv() {
  return { DB: new FakeD1(), GRANT_JWT: SECRET };
}

// A complete, well-formed device payload — this is what makes the
// original repro convincing. The only thing missing is the header.
function deviceBody(device_id = 'y', extra = {}) {
  return {
    ...extra,
    device: {
      device_id,
      name: 'attacker-laptop',
      platform: 'linux',
      app_version: '1.0.0',
    },
  };
}

async function post(path, headers, body) {
  const req = new Request(`https://test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return path === '/api/keys/revoke' ? handleRevokeDevice(req, TESTENV) : handleRegisterDevice(req, TESTENV);
}

let TESTENV;

beforeEach(() => {
  TESTENV = makeEnv();
});

describe('POST /api/keys/register — fails closed without Access', () => {

  it('returns 401 when cf-access-authenticated-user-email is absent', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register', {}, deviceBody('no-header'));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('access_required');
    expect(r.body.device_token).toBeUndefined();
  });

  it('returns 401 when the header is present but blank', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': '   ' }, deviceBody('blank-header'));
    expect(r.status).toBe(401);
    expect(r.body.device_token).toBeUndefined();
  });

  it('returns 401 even when the body names a real-looking tenant', async () => {
    // This is the original exploit shape. Before the fix it returned a
    // 365-day memory:write token for 'victim-tenant'.
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register', {},
      deviceBody('attacker-dev', { user_id: 'victim-tenant' }));
    expect(r.status).toBe(401);
    expect(r.body.device_token).toBeUndefined();
  });

  it('does not create a device row for a rejected registration', async () => {
    const env = makeEnv();
    TESTENV = env;
    await post('/api/keys/register', {}, deviceBody('ghost-dev', { user_id: 'victim' }));
    const rows = env.DB.tables.get('devices') || [];
    expect(rows.length).toBe(0);
  });

  it('401s before it looks at the body at all (malformed body is still 401)', async () => {
    // Guard against a future refactor that moves the auth check below
    // the JSON parse, which would let an attacker probe the endpoint.
    const req = new Request('https://test/api/keys/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    const r = await handleRegisterDevice(req, makeEnv());
    expect(r.status).toBe(401);
  });
});

describe('POST /api/keys/register — identity is Access-derived, body is ignored', () => {

  it('ignores a body user_id that disagrees with the header', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'alice@example.com' },
      deviceBody('d-a', { user_id: 'bob@example.com' }));

    expect(r.status).toBe(200);
    // The header wins, and it wins by hash — not by the literal string.
    expect(r.body.user_id).toBe(await userIdFor('alice@example.com'));
    expect(r.body.user_id).not.toBe('bob@example.com');
  });

  it('derives user_id as sha256(email), not the raw email', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'alice@example.com' }, deviceBody('d-a'));
    expect(r.body.user_id).toBe(await userIdFromEmail('alice@example.com'));
    expect(r.body.user_id).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.user_id).not.toContain('alice');
    expect(r.body.user_id).not.toContain('@');
  });

  it('normalizes email case so the same person gets one tenant', async () => {
    const env = makeEnv();
    TESTENV = env;
    const a = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'Alice@Example.COM' }, deviceBody('d1'));
    const b = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'alice@example.com' }, deviceBody('d2'));
    expect(a.body.user_id).toBe(b.body.user_id);
  });

  it('mints the token with sub = the Access identity, not the body claim', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'alice@example.com' },
      deviceBody('d-a', { user_id: 'bob@example.com' }));
    const claims = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${r.body.device_token}`,
      db: env.DB,
    });
    expect(claims.ok).toBe(true);
    expect(claims.claims.sub).toBe(await userIdFor('alice@example.com'));
  });

  it('still validates the device fields', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'alice@example.com' },
      { device: { device_id: 'd' } });
    expect(r.status).toBe(400);
  });

  it('stores email_hash rather than an email address', async () => {
    const env = makeEnv();
    TESTENV = env;
    await post('/api/keys/register',
      { 'cf-access-authenticated-user-email': 'alice@example.com' }, deviceBody('d-a'));
    const users = env.DB.tables.get('users');
    expect(users.length).toBe(1);
    expect(users[0].user_id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(users[0])).not.toContain('example.com');
  });
});

describe('POST /api/keys/revoke — a leaked token can be invalidated', () => {

  it('401s without an Access header', async () => {
    const env = makeEnv();
    TESTENV = env;
    const r = await post('/api/keys/revoke', {}, { device_id: 'd-a' });
    expect(r.status).toBe(401);
  });

  it('rejects the revoked token on GET /api/sync/devices with 401', async () => {
    const env = makeEnv();
    TESTENV = env;
    const alice = await loginAs(env, 'alice@example.com', 'd-a');
    expect(alice.status).toBe(200);

    // Token works before revocation.
    const before = await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', alice.token), env);
    expect(before.status).toBe(200);

    const rev = await post('/api/keys/revoke',
      { 'cf-access-authenticated-user-email': 'alice@example.com' },
      { device_id: 'd-a' });
    expect(rev.status).toBe(200);
    expect(rev.body.ok).toBe(true);

    // ...and not after. The token's signature and exp are still valid;
    // only the D1 row says otherwise.
    const after = await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', alice.token), env);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('device_revoked');
  });

  it('rejects the revoked token on POST /api/sync/upload too', async () => {
    const env = makeEnv();
    TESTENV = env;
    const alice = await loginAs(env, 'alice@example.com', 'd-a');
    await post('/api/keys/revoke',
      { 'cf-access-authenticated-user-email': 'alice@example.com' }, { device_id: 'd-a' });
    const r = await handleSyncUpload(authedReq('/api/sync/upload', 'POST', alice.token, {}), env);
    expect(r.status).toBe(401);
  });

  it('cannot be used to revoke another tenant\'s device', async () => {
    const env = makeEnv();
    TESTENV = env;
    const bob = await loginAs(env, 'bob@example.com', 'd-bob');
    const r = await post('/api/keys/revoke',
      { 'cf-access-authenticated-user-email': 'attacker@example.com' },
      { device_id: 'd-bob' });
    expect(r.status).toBe(404);

    // Bob's token still works — the 404 did not revoke it.
    const still = await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', bob.token), env);
    expect(still.status).toBe(200);
  });

  it('404s on an unknown device and 400s without a device_id', async () => {
    const env = makeEnv();
    TESTENV = env;
    const h = { 'cf-access-authenticated-user-email': 'alice@example.com' };
    expect((await post('/api/keys/revoke', h, { device_id: 'nope' })).status).toBe(404);
    expect((await post('/api/keys/revoke', h, {})).status).toBe(400);
  });

  it('is idempotent — second revoke 404s rather than erroring', async () => {
    const env = makeEnv();
    TESTENV = env;
    const h = { 'cf-access-authenticated-user-email': 'alice@example.com' };
    await loginAs(env, 'alice@example.com', 'd-a');
    expect((await post('/api/keys/revoke', h, { device_id: 'd-a' })).status).toBe(200);
    expect((await post('/api/keys/revoke', h, { device_id: 'd-a' })).status).toBe(404);
  });

  it('keeps the device row so sync history survives (tombstone, not DELETE)', async () => {
    const env = makeEnv();
    TESTENV = env;
    await loginAs(env, 'alice@example.com', 'd-a');
    await post('/api/keys/revoke',
      { 'cf-access-authenticated-user-email': 'alice@example.com' }, { device_id: 'd-a' });
    const rows = env.DB.tables.get('devices');
    expect(rows.length).toBe(1);
    expect(rows[0].revoked_at).toBeTypeOf('number');
  });
});

describe('cross-tenant isolation extends to /api/sync/*', () => {

  it("user A's token cannot read user B's devices", async () => {
    const env = makeEnv();
    TESTENV = env;
    const alice = await loginAs(env, 'alice@example.com', 'd-alice');
    await loginAs(env, 'bob@example.com', 'd-bob');

    const r = await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', alice.token), env);
    expect(r.status).toBe(200);
    // Alice sees only her own device, never bob's.
    expect(r.body.devices.map((d) => d.device_id)).toEqual(['d-alice']);
    expect(JSON.stringify(r.body)).not.toContain('d-bob');
  });

  it("user A's token cannot read user B's devices by naming B's device id", async () => {
    const env = makeEnv();
    TESTENV = env;
    const alice = await loginAs(env, 'alice@example.com', 'd-alice');
    await loginAs(env, 'bob@example.com', 'd-bob');
    // handleSyncDevices scopes by the JWT sub and takes no device_id
    // parameter, so asking for bob's device id as a query param cannot
    // widen the result set — alice still sees only alice.
    const r = await handleSyncDevices(
      authedReq('/api/sync/devices?device_id=d-bob', 'GET', alice.token), env);
    expect(r.status).toBe(200);
    expect(r.body.devices.map((d) => d.device_id)).toEqual(['d-alice']);
    expect(JSON.stringify(r.body)).not.toContain('d-bob');
  });

  it("user B's revoked device does not affect user A's access", async () => {
    const env = makeEnv();
    TESTENV = env;
    const alice = await loginAs(env, 'alice@example.com', 'd-alice');
    const bob = await loginAs(env, 'bob@example.com', 'd-bob');
    await post('/api/keys/revoke',
      { 'cf-access-authenticated-user-email': 'bob@example.com' }, { device_id: 'd-bob' });

    expect((await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', bob.token), env)).status).toBe(401);
    expect((await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', alice.token), env)).status).toBe(200);
  });

  it('a token minted for a purged device is rejected (fail closed on unknown row)', async () => {
    // Simulates a token that outlives its device row — e.g. someone
    // deleted rows directly in D1, as the security investigation had
    // to do. An unknown device must not mean "trusted".
    const env = makeEnv();
    TESTENV = env;
    const { jwt } = await signGrant({
      secret: SECRET,
      sub: await userIdFor('alice@example.com'),
      bot_id: 'never-registered',
      scope: SCOPE_WRITE,
      ttl_seconds: 3600,
      issuer: 'seele-cloud:device',
    });
    const r = await handleSyncDevices(
      authedReq('/api/sync/devices', 'GET', jwt), env);
    expect(r.status).toBe(401);
  });
});