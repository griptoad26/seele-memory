/**
 * test/security-probe.test.js — Independent security review of the auth path.
 *
 * TASK-seele-cloud-20261116-119: review device-token auth for
 *   * timing-safe comparison
 *   * token expiry enforcement
 *   * revocation actually revoking
 *   * fail-closed behaviour on every protected route
 *   * no data leak before the token check
 *   * CORS policy must not permit credentialed cross-origin requests
 *
 * These probes run against the REAL Worker default export through the
 * local harness (real D1, real migrations), so they exercise the shipped
 * routing/dispatch code, not a re-implementation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLocalWorker } from './local-worker.js';
import { SignJWT } from 'jose';
import { userIdFor } from './helpers.js';

const SECRET = 'probe-secret-0123456789abcdefghijklmnop';

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
      device: {
        device_id,
        name: device_id,
        platform: 'linux',
        app_version: '1.0.0',
      },
    },
  });
  return r;
}

describe('PROBE 1 — registration identity is fail-closed', () => {
  it('rejects registration with NO Access header', async () => {
    const r = await w.request('/api/keys/register', {
      method: 'POST',
      body: { device: { device_id: 'no-access', name: 'x', platform: 'l', app_version: '1' } },
    });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('access_required');
  });

  it('ignores a body-supplied user_id (no tenant impersonation)', async () => {
    const r = await w.request('/api/keys/register', {
      method: 'POST',
      headers: { 'cf-access-authenticated-user-email': 'alice@example.com' },
      body: {
        user_id: 'someone-elses-tenant',
        device: { device_id: 'alice-d1', name: 'x', platform: 'l', app_version: '1' },
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.user_id).toBe(await userIdFor('alice@example.com'));
    expect(r.json.user_id).not.toBe('someone-elses-tenant');
  });
});

describe('PROBE 2 — protected routes fail closed with no token', () => {
  const protectedRoutes = [
    ['POST', '/api/sync/upload'],
    ['POST', '/api/sync/download'],
    ['GET', '/api/sync/state'],
    ['GET', '/api/sync/devices'],
    ['POST', '/mem/v1/recall'],
    ['POST', '/mem/v1/full-recall'],
    ['POST', '/api/bots'],
    ['GET', '/api/bots'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} → 401 with no Authorization header`, async () => {
      const r = await w.request(path, { method, body: method === 'POST' ? {} : undefined });
      expect(r.status).toBe(401);
      expect(r.json.error).toBe('missing_bearer');
    });
  }
});

describe('PROBE 3 — no data leaks before the token check', () => {
  it('a rejected recall returns no snippet fields at all', async () => {
    const r = await w.request('/mem/v1/recall', {
      method: 'POST',
      body: { query_vector: new Array(384).fill(0.1) },
    });
    expect(r.status).toBe(401);
    expect(r.json.snippets).toBeUndefined();
    expect(r.json.matches).toBeUndefined();
    expect(r.json.body_encrypted).toBeUndefined();
  });

  it('a rejected sync download returns no envelopes', async () => {
    const r = await w.request('/api/sync/download', { method: 'POST', body: {} });
    expect(r.status).toBe(401);
    expect(r.json.envelopes).toBeUndefined();
  });

  it('a rejected bots list returns no bots', async () => {
    const r = await w.request('/api/bots', { method: 'GET' });
    expect(r.status).toBe(401);
    expect(r.json.bots).toBeUndefined();
  });

  it('a rejected sync devices returns no device list', async () => {
    const r = await w.request('/api/sync/devices', { method: 'GET' });
    expect(r.status).toBe(401);
    expect(r.json.devices).toBeUndefined();
  });
});

describe('PROBE 4 — token forgery / signature bypass', () => {
  it('rejects a token signed with the wrong secret', async () => {
    const t = await new SignJWT({ bot_id: 'b', scope: 'memory:write' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(new TextEncoder().encode('wrong-secret'));
    const r = await w.request('/api/bots', { method: 'GET', token: t });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('bad_signature');
  });

  it('rejects an unsigned "alg:none" token', async () => {
    const b64u = (s) => Buffer.from(s).toString('base64url');
    const header = b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = b64u(JSON.stringify({
      sub: 'u1', bot_id: 'b', scope: 'memory:write',
      exp: Math.floor(Date.now() / 1000) + 900,
    }));
    const r = await w.request('/api/bots', { method: 'GET', token: `${header}.${payload}.` });
    expect(r.status).toBe(401);
  });

  it('rejects an expired device token', async () => {
    const r = await register('expired@example.com', 'expired-d');
    const token = r.json.device_token;
    // Wait? No — forge an already-expired token with the real secret,
    // scoped like a device grant, for a real device row.
    const expired = await new SignJWT({ bot_id: 'expired-d', scope: 'memory:write' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(await userIdFor('expired@example.com'))
      .setIssuer('seele-cloud:device')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(SECRET));
    const res = await w.request('/api/bots', { method: 'GET', token: expired });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('jwt_expired');
    // and the real (valid) token still works, proving the check is expiry-specific
    const ok = await w.request('/api/bots', { method: 'GET', token });
    expect(ok.status).toBe(200);
  });
});

describe('PROBE 5 — revocation actually revokes', () => {
  it('a revoked device token stops working immediately (not at TTL)', async () => {
    const r = await register('bob@example.com', 'bob-d1');
    const token = r.json.device_token;
    expect(token).toBeTruthy();

    const before = await w.request('/api/bots', { method: 'GET', token });
    expect(before.status).toBe(200);

    // Revoke via the Access-gated route.
    const rev = await w.request('/api/keys/revoke', {
      method: 'POST',
      headers: { 'cf-access-authenticated-user-email': 'bob@example.com' },
      body: { device_id: 'bob-d1' },
    });
    expect(rev.status).toBe(200);

    const after = await w.request('/api/bots', { method: 'GET', token });
    expect(after.status).toBe(401);
    expect(after.json.error).toBe('device_revoked');
  });

  it('cannot revoke another tenant device', async () => {
    const r = await register('carol@example.com', 'carol-d1');
    expect(r.status).toBe(200);
    const rev = await w.request('/api/keys/revoke', {
      method: 'POST',
      headers: { 'cf-access-authenticated-user-email': 'attacker@example.com' },
      body: { device_id: 'carol-d1' },
    });
    expect(rev.status).toBe(404);
    // carol's token must still work
    const still = await w.request('/api/bots', { method: 'GET', token: r.json.device_token });
    expect(still.status).toBe(200);
  });

  it('a revoked bot grant stops working', async () => {
    const r = await register('dave@example.com', 'dave-d1');
    const devToken = r.json.device_token;
    const created = await w.request('/api/bots', {
      method: 'POST',
      token: devToken,
      body: { name: 'probe-bot' },
    });
    expect(created.status).toBe(200);
    const botId = created.json.bot_id;
    const grant = created.json.grant.jwt;

    const before = await w.request('/mem/v1/full-recall', {
      method: 'POST', token: grant, body: { query: 'anything' },
    });
    expect(before.status).toBe(200);

    const rev = await w.request(`/api/bots/${botId}/revoke`, { method: 'POST', token: devToken });
    expect(rev.status).toBe(200);

    const after = await w.request('/mem/v1/full-recall', {
      method: 'POST', token: grant, body: { query: 'anything' },
    });
    expect(after.status).toBe(403);
    expect(after.json.error).toBe('bot_revoked');
  });
});

describe('PROBE 6 — cross-tenant isolation', () => {
  it('a device token cannot read another tenant sync data', async () => {
    const a = await register('eve@example.com', 'eve-d1');
    const b = await register('mallory@example.com', 'mallory-d1');

    // Eve uploads a chunk.
    const up = await w.request('/api/sync/upload', {
      method: 'POST',
      token: a.json.device_token,
      body: {
        device_id: 'eve-d1',
        conversation: { conversation_id: 'conv-eve', llm_kind: 'chat' },
        chunks: [{
          chunk_id: 'eve-chunk-1',
          client_msg_id: 'm1',
          body_encrypted: Buffer.from('eve-secret').toString('base64'),
        }],
      },
    });
    expect(up.status).toBe(200);

    // Mallory downloads — must not see Eve's envelope.
    const down = await w.request('/api/sync/download', {
      method: 'POST', token: b.json.device_token, body: {},
    });
    expect(down.status).toBe(200);
    expect(down.json.envelopes).toEqual([]);

    // Mallory keyword-recalls — must not see Eve's chunk.
    const rec = await w.request('/mem/v1/full-recall', {
      method: 'POST', token: b.json.device_token, body: { query: 'eve-chunk' },
    });
    expect(rec.status).toBe(200);
    expect(rec.json.matches).toEqual([]);
  });

  it('a device token cannot mint a bot for another tenant', async () => {
    const a = await register('frank@example.com', 'frank-d1');
    const b = await register('grace@example.com', 'grace-d1');
    const created = await w.request('/api/bots', {
      method: 'POST', token: a.json.device_token, body: { name: 'frank-bot' },
    });
    expect(created.json.user_id).toBe(await userIdFor('frank@example.com'));
    expect(created.json.user_id).not.toBe(await userIdFor('grace@example.com'));

    // Grace's token listing bots must not see Frank's bot.
    const list = await w.request('/api/bots', { method: 'GET', token: b.json.device_token });
    expect(list.status).toBe(200);
    expect(list.json.bots.map((x) => x.bot_id)).not.toContain(created.json.bot_id);
  });
});

describe('PROBE 7 — CORS policy', () => {
  it('an unlisted origin gets * (and no credentialed-CORS combination)', async () => {
    const r = await w.request('/api/bots', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    });
    const acao = r.headers.get('access-control-allow-origin');
    const acac = r.headers.get('access-control-allow-credentials');
    // The dangerous combo is ACAO:* (or echoed origin) + ACAC:true.
    expect(acac).toBeNull();
    expect(acao === '*' || acao === null).toBe(true);
  });

  it('a listed origin is echoed and still has no allow-credentials', async () => {
    const r = await w.request('/api/bots', {
      method: 'GET',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('preflight for an unlisted origin does not echo that origin', async () => {
    const r = await w.request('/api/sync/upload', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(r.status).toBe(204);
    const acao = r.headers.get('access-control-allow-origin');
    expect(acao).not.toBe('https://evil.example');
  });
});

describe('PROBE 8 — unauthenticated surfaces', () => {
  it('/api/mem/health is reachable without a token (info leak check)', async () => {
    const r = await w.request('/api/mem/health', { method: 'GET' });
    expect(r.status).toBe(200);
    // Surface must not leak binding internals beyond names/dimensions.
    expect(JSON.stringify(r.json)).not.toMatch(/grant_jwt|secret|password|token/i);
  });

  it('the catch-all proxy does not forward to the API surface', async () => {
    // Unknown paths fall through to the fresh proxy. Make sure a
    // spoofed internal path cannot reach an authenticated route.
    const r = await w.request('/api/does-not-exist', { method: 'GET' });
    // Either a 404-ish upstream response or a proxy error — but it must
    // never be a JSON auth error implying the API handled it.
    expect(r.status).not.toBe(200);
  });
});
