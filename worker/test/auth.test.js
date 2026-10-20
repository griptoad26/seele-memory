/**
 * test/auth.test.js — Grant JWT validation suite.
 *
 * Covers:
 *   * valid grant → ok, claims correct
 *   * expired grant → 401 jwt_expired
 *   * wrong scope → 403 insufficient_scope
 *   * bad signature → 401 bad_signature
 *   * tampered payload → 401 jwt_invalid / claim_invalid
 *   * missing Authorization header → 401 missing_bearer
 *   * revoked bot → 403 bot_revoked
 *
 * Each case uses the same shape (build a token, call verifyGrant, assert)
 * so failures look obvious in the output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import {
  verifyGrant,
  signGrant,
  bearerToken,
  scopeSatisfies,
  SCOPE_RECALL,
  SCOPE_WRITE,
} from '../src/auth.js';
import { FakeD1 } from './fake-d1.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567890abcdef';

function newDb() {
  return new FakeD1();
}

async function makeToken({ secret = SECRET, sub = 'u1', bot_id = 'b1', scope = SCOPE_WRITE, ttl = 900, payloadExtras = {} }) {
  const expSeconds = Math.floor(Date.now() / 1000) + ttl;
  return await new SignJWT({ bot_id, scope, ...payloadExtras })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer('seele-cloud:test')
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(new TextEncoder().encode(secret));
}

describe('bearerToken', () => {
  it('returns the token on a valid header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });
  it('handles trailing whitespace', () => {
    expect(bearerToken('Bearer abc.def.ghi   ')).toBe('abc.def.ghi');
  });
  it('returns null on missing header', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
  });
  it('returns null on non-Bearer scheme', () => {
    expect(bearerToken('Basic abc')).toBeNull();
  });
});

describe('verifyGrant — happy path', () => {
  it('accepts a freshly minted HS256 grant', async () => {
    const token = await makeToken({});
    const r = await verifyGrant({ secret: SECRET, authorization: `Bearer ${token}` });
    expect(r.ok).toBe(true);
    expect(r.claims.sub).toBe('u1');
    expect(r.claims.bot_id).toBe('b1');
    expect(r.claims.scope).toBe(SCOPE_WRITE);
  });

  it('accepts memory:write for a recall-required handler', async () => {
    const token = await makeToken({ scope: SCOPE_WRITE });
    const r = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${token}`,
      required_scope: SCOPE_RECALL,
    });
    expect(r.ok).toBe(true);
  });
});

describe('verifyGrant — failure modes', () => {
  it('rejects missing Authorization header', async () => {
    const r = await verifyGrant({ secret: SECRET, authorization: null });
    expect(r.ok).toBe(false);
    expect(r.error.status).toBe(401);
    expect(r.error.code).toBe('missing_bearer');
  });

  it('rejects malformed Authorization header', async () => {
    const r = await verifyGrant({ secret: SECRET, authorization: 'not-bearer at-all' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('missing_bearer');
  });

  it('rejects expired token', async () => {
    // Mint with negative ttl so exp is already past.
    const token = await new SignJWT({ bot_id: 'b1', scope: SCOPE_WRITE })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setIssuer('seele-cloud:test')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    const r = await verifyGrant({ secret: SECRET, authorization: `Bearer ${token}` });
    expect(r.ok).toBe(false);
    expect(r.error.status).toBe(401);
    expect(r.error.code).toBe('jwt_expired');
  });

  it('rejects bad signature', async () => {
    const token = await makeToken({});
    const r = await verifyGrant({
      secret: 'different-secret-1234567890abcdefghij',
      authorization: `Bearer ${token}`,
    });
    expect(r.ok).toBe(false);
    expect(r.error.status).toBe(401);
    expect(r.error.code).toBe('bad_signature');
  });

  it('rejects malformed JWT', async () => {
    const r = await verifyGrant({
      secret: SECRET,
      authorization: 'Bearer not.a.real.jwt',
    });
    expect(r.ok).toBe(false);
    expect(r.error.status).toBe(401);
    expect(['jwt_invalid', 'jwt_expired']).toContain(r.error.code);
  });

  it('rejects token missing sub', async () => {
    const token = await new SignJWT({ bot_id: 'b1', scope: SCOPE_WRITE })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('seele-cloud:test')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(new TextEncoder().encode(SECRET));
    const r = await verifyGrant({ secret: SECRET, authorization: `Bearer ${token}` });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('missing_sub');
  });

  it('rejects token missing bot_id', async () => {
    const token = await new SignJWT({ scope: SCOPE_WRITE })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(new TextEncoder().encode(SECRET));
    const r = await verifyGrant({ secret: SECRET, authorization: `Bearer ${token}` });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('missing_bot_id');
  });

  it('rejects unknown scope', async () => {
    const token = await new SignJWT({ bot_id: 'b1', scope: 'memory:admin' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(new TextEncoder().encode(SECRET));
    const r = await verifyGrant({ secret: SECRET, authorization: `Bearer ${token}` });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('invalid_scope');
  });

  it('rejects memory:recall for a memory:write handler (insufficient scope)', async () => {
    const token = await makeToken({ scope: SCOPE_RECALL });
    const r = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${token}`,
      required_scope: SCOPE_WRITE,
    });
    expect(r.ok).toBe(false);
    expect(r.error.status).toBe(403);
    expect(r.error.code).toBe('insufficient_scope');
  });
});

describe('verifyGrant — revocation', () => {
  it('allows when no bot row exists (device-issued or unknown token)', async () => {
    // A grant without a corresponding bots row is allowed: it could be a
    // device grant (bot_id = device_id) or a brand-new token not yet
    // registered. The JWT signature + TTL is the trust boundary; the
    // bots table adds an additional revocation layer for *known* bots.
    const db = newDb();
    const token = await makeToken({});
    const r = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${token}`,
      db,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when the bot row belongs to a different user', async () => {
    const db = newDb();
    db._insert('bots', {
      bot_id: 'b1',
      user_id: 'someone-else',
      name: 'sneaky',
      public_key_ed25519: new Uint8Array(32),
      scope_tags: '[]',
      expires_at: null,
      revoked_at: null,
      created_at: Date.now(),
    });
    const token = await makeToken({ sub: 'u1', bot_id: 'b1' });
    const r = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${token}`,
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bot_revoked');
  });

  it('rejects when the bot is revoked', async () => {
    const db = newDb();
    db._insert('bots', {
      bot_id: 'b1',
      user_id: 'u1',
      name: 'old',
      public_key_ed25519: new Uint8Array(32),
      scope_tags: '[]',
      expires_at: null,
      revoked_at: Date.now() - 1000,
      created_at: Date.now() - 10000,
    });
    const token = await makeToken({});
    const r = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${token}`,
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bot_revoked');
  });

  it('accepts an active bot owned by the JWT subject', async () => {
    const db = newDb();
    db._insert('bots', {
      bot_id: 'b1',
      user_id: 'u1',
      name: 'good bot',
      public_key_ed25519: new Uint8Array(32),
      scope_tags: '[]',
      expires_at: null,
      revoked_at: null,
      created_at: Date.now(),
    });
    const token = await makeToken({});
    const r = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${token}`,
      db,
    });
    expect(r.ok).toBe(true);
  });
});

describe('scopeSatisfies', () => {
  it('exact match', () => {
    expect(scopeSatisfies(SCOPE_WRITE, SCOPE_WRITE)).toBe(true);
    expect(scopeSatisfies(SCOPE_RECALL, SCOPE_RECALL)).toBe(true);
  });
  it('write satisfies recall', () => {
    expect(scopeSatisfies(SCOPE_WRITE, SCOPE_RECALL)).toBe(true);
  });
  it('recall does NOT satisfy write', () => {
    expect(scopeSatisfies(SCOPE_RECALL, SCOPE_WRITE)).toBe(false);
  });
});

describe('signGrant', () => {
  it('produces a token the verifier accepts', async () => {
    const { jwt } = await signGrant({
      secret: SECRET,
      sub: 'user-123',
      bot_id: 'bot-xyz',
      scope: SCOPE_WRITE,
    });
    const r = await verifyGrant({ secret: SECRET, authorization: `Bearer ${jwt}` });
    expect(r.ok).toBe(true);
    expect(r.claims.sub).toBe('user-123');
    expect(r.claims.bot_id).toBe('bot-xyz');
  });

  it('rejects an invalid scope at sign time', async () => {
    await expect(
      signGrant({ secret: SECRET, sub: 'u', bot_id: 'b', scope: 'memory:admin' })
    ).rejects.toThrow(/invalid scope/);
  });
});