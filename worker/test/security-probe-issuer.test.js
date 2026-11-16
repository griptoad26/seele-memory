/**
 * test/security-probe-issuer.test.js — issuer-branch / revocation-bypass probe.
 *
 * TASK-seele-cloud-20261116-119.
 *
 * verifyGrant() branches on the `iss` claim:
 *   iss === 'seele-cloud:device'  -> checkDeviceRevoked()  (row MUST exist)
 *   anything else                  -> checkRevoked()        (row MISSING => ALLOW)
 *
 * checkRevoked() returns false (do not reject) when the bots table has no
 * row for the claim's bot_id. The doc comment explains why: device-issued
 * grants used to be waved through because bot_id IS the device_id.
 *
 * That comment is now stale — device grants get their own branch and their
 * own strict check. But the *bot* branch still has the permissive fallback.
 * These probes test whether that permissive fallback can be reached with a
 * revoked / cross-tenant device.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLocalWorker } from './local-worker.js';
import { SignJWT } from 'jose';
import { userIdFor } from './helpers.js';

const SECRET = 'issuer-probe-secret-0123456789abcdefghijkl';
let w;

beforeAll(async () => {
  w = await startLocalWorker({ grantJwt: SECRET });
});

afterAll(async () => {
  if (w) await w.stop();
});

async function register(email, device_id) {
  const r = await w.request('/api/keys/register', {
    method: 'POST',
    headers: { 'cf-access-authenticated-user-email': email },
    body: {
      device: { device_id, name: device_id, platform: 'linux', app_version: '1.0.0' },
    },
  });
  return r;
}

async function mint({ sub, bot_id, iss, scope = 'memory:write', ttl = 900 }) {
  return new SignJWT({ bot_id, scope })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(iss)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(new TextEncoder().encode(SECRET));
}

describe('PROBE 10 — issuer branch strictness', () => {
  it('a revoked device token re-issued with a non-device issuer is REJECTED', async () => {
    const r = await register('mallory@example.com', 'mallory-d1');
    expect(r.status).toBe(200);
    const userId = await userIdFor('mallory@example.com');

    // Revoke the device.
    const rev = await w.request('/api/keys/revoke', {
      method: 'POST',
      headers: { 'cf-access-authenticated-user-email': 'mallory@example.com' },
      body: { device_id: 'mallory-d1' },
    });
    expect(rev.status).toBe(200);

    // Re-mint with iss='seele-cloud:bot'. Pre-fix the bot branch's
    // checkRevoked() found NO row in `bots` with bot_id='mallory-d1'
    // and the "no bot row => not revoked" fallback ALLOWED it.
    // Post-fix the bot branch also consults the devices table and
    // rejects.
    const forged = await mint({ sub: userId, bot_id: 'mallory-d1', iss: 'seele-cloud:bot' });
    const res = await w.request('/api/bots', { method: 'GET', token: forged });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('bot_revoked');
  });

  it('a device token re-issued with iss=seele-cloud:device is rejected (strict device branch)', async () => {
    const r = await register('oscar@example.com', 'oscar-d1');
    const userId = await userIdFor('oscar@example.com');
    await w.request('/api/keys/revoke', {
      method: 'POST',
      headers: { 'cf-access-authenticated-user-email': 'oscar@example.com' },
      body: { device_id: 'oscar-d1' },
    });
    const forged = await mint({ sub: userId, bot_id: 'oscar-d1', iss: 'seele-cloud:device' });
    const res = await w.request('/api/bots', { method: 'GET', token: forged });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('device_revoked');
  });

  it('a grant naming an identifier in NEITHER table is ALLOWED (documented contract)', async () => {
    const userId = await userIdFor('ghost@example.com');
    const forged = await mint({ sub: userId, bot_id: 'never-registered-device', iss: 'seele-cloud:bot' });
    const res = await w.request('/api/bots', { method: 'GET', token: forged });
    // An unknown identifier is not "revoked" — the signature + TTL is the
    // trust boundary there. See test/auth.test.js "allows when no bot row
    // exists". The fix targets REVOKED credentials, not unknown ones.
    expect(res.status).toBe(200);
  });

  it('a live device grant still works after the hardening', async () => {
    const r = await register('peggy@example.com', 'peggy-d1');
    const res = await w.request('/api/bots', { method: 'GET', token: r.json.device_token });
    expect(res.status).toBe(200);
  });
});
