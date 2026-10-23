/**
 * test/bots.test.js — Bot lifecycle: create / list / revoke.
 *
 * Covers:
 *   * creating a bot mints a grant JWT + returns the private_key once
 *   * listing returns only the caller's bots (cross-user isolation)
 *   * revocation invalidates the grant at the auth layer
 *   * revoked_at timestamp round-trips
 */

import { describe, it, expect } from 'vitest';
import { handleCreateBot, handleListBots, handleRevokeBot } from '../src/bots.js';
import { loginAs, userIdFor } from './helpers.js';
import { handleRecall } from '../src/recall.js';
import { signGrant, verifyGrant, SCOPE_WRITE } from '../src/auth.js';
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

// `login` is the logical tenant name ('alice', 'bob'); the Worker derives
// the real user_id from the Access email, so tests never hand-write one.
async function login(env, login, device_id) {
  const r = await loginAs(env, `${login}@example.com`, device_id);
  return r.token;
}

async function authedReq(url, method, token, body) {
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

describe('POST /api/bots', () => {
  it('creates a bot, returns a grant JWT + private key', async () => {
    const env = makeEnv();
    const token = await login(env, 'alice', 'd-a');

    const req = await authedReq('/api/bots', 'POST', token, {
      name: 'claude-assistant',
      scope_tags: ['decisions', 'rust-projects'],
    });
    const r = await handleCreateBot(req, env, null);
    expect(r.status).toBe(200);
    expect(r.body.bot_id).toBeTypeOf('string');
    expect(r.body.user_id).toBe(await userIdFor('alice@example.com'));
    expect(r.body.name).toBe('claude-assistant');
    expect(r.body.scope_tags).toEqual(['decisions', 'rust-projects']);
    expect(r.body.grant.jwt).toBeTypeOf('string');
    expect(r.body.grant.scope).toBe('memory:write');
    expect(r.body.private_key).toBeTypeOf('string');
    expect(r.body.public_key).toBeTypeOf('string');
    expect(r.body.warning).toMatch(/private_key/);

    // The grant must verify.
    const v = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${r.body.grant.jwt}`,
      db: env.DB,
    });
    expect(v.ok).toBe(true);
    expect(v.claims.bot_id).toBe(r.body.bot_id);
  });

  it('rejects a name-less body', async () => {
    const env = makeEnv();
    const token = await login(env, 'alice', 'd-a');

    const r = await handleCreateBot(
      await authedReq('/api/bots', 'POST', token, { scope_tags: [] }),
      env,
      null,
    );
    expect(r.status).toBe(400);
  });

  it('rejects requests with no Bearer token', async () => {
    const env = makeEnv();
    const r = await handleCreateBot(
      new Request('https://test/api/bots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      }),
      env,
      null,
    );
    expect(r.status).toBe(401);
  });

  it('rejects when GRANT_JWT secret is missing', async () => {
    const env = makeEnv();
    env.GRANT_JWT = undefined;
    const token = await login(env, 'alice', 'd-a');

    const r = await handleCreateBot(
      await authedReq('/api/bots', 'POST', token, { name: 'x' }),
      env,
      null,
    );
    // No secret → JWT verify fails (bad signature). 401 is honest;
    // the alternative (sign with empty key) would be a security smell.
    expect(r.status).toBe(401);
    expect(['bad_signature', 'jwt_invalid']).toContain(r.body.error);
  });

  it('bot grant can call /mem/v1/recall', async () => {
    const env = makeEnv();
    const token = await login(env, 'alice', 'd-a');

    const cr = await handleCreateBot(
      await authedReq('/api/bots', 'POST', token, { name: 'recall-bot' }),
      env,
      null,
    );
    expect(cr.status).toBe(200);

    const recall = await handleRecall(
      await authedReq('/mem/v1/recall', 'POST', cr.body.grant.jwt, {
        query_vector: new Array(384).fill(0),
      }),
      env,
    );
    expect(recall.status).toBe(200);
  });
});

describe('GET /api/bots', () => {
  it('lists only the caller\'s bots', async () => {
    const env = makeEnv();
    const aTok = await login(env, 'alice', 'd-a');
    const bTok = await login(env, 'bob', 'd-b');

    await handleCreateBot(await authedReq('/api/bots', 'POST', aTok, { name: 'a-1' }), env, null);
    await handleCreateBot(await authedReq('/api/bots', 'POST', aTok, { name: 'a-2' }), env, null);
    await handleCreateBot(await authedReq('/api/bots', 'POST', bTok, { name: 'b-1' }), env, null);

    const aList = await handleListBots(await authedReq('/api/bots', 'GET', aTok), env);
    expect(aList.status).toBe(200);
    expect(aList.body.bots.length).toBe(2);
    for (const b of aList.body.bots) {
      expect(b.name).toMatch(/^a-/);
    }

    const bList = await handleListBots(await authedReq('/api/bots', 'GET', bTok), env);
    expect(bList.body.bots.length).toBe(1);
    expect(bList.body.bots[0].name).toBe('b-1');
  });
});

describe('POST /api/bots/:id/revoke', () => {
  it('revokes the bot and invalidates its grant', async () => {
    const env = makeEnv();
    const token = await login(env, 'alice', 'd-a');
    const cr = await handleCreateBot(
      await authedReq('/api/bots', 'POST', token, { name: 'doomed' }),
      env,
      null,
    );
    expect(cr.status).toBe(200);

    // Grant works pre-revoke.
    const beforeV = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${cr.body.grant.jwt}`,
      db: env.DB,
    });
    expect(beforeV.ok).toBe(true);

    // Revoke.
    const rr = await handleRevokeBot(
      await authedReq(`/api/bots/${cr.body.bot_id}/revoke`, 'POST', token),
      env,
      cr.body.bot_id,
    );
    expect(rr.status).toBe(200);
    expect(rr.body.bot_id).toBe(cr.body.bot_id);
    expect(rr.body.revoked_at).toBeGreaterThan(0);

    // Grant fails post-revoke.
    const afterV = await verifyGrant({
      secret: SECRET,
      authorization: `Bearer ${cr.body.grant.jwt}`,
      db: env.DB,
    });
    expect(afterV.ok).toBe(false);
    expect(afterV.error.code).toBe('bot_revoked');
  });

  it('returns 404 for an unknown bot', async () => {
    const env = makeEnv();
    const token = await login(env, 'alice', 'd-a');
    const r = await handleRevokeBot(
      await authedReq('/api/bots/nonexistent/revoke', 'POST', token),
      env,
      'nonexistent',
    );
    expect(r.status).toBe(404);
  });

  it('returns 403 if the bot belongs to a different user', async () => {
    const env = makeEnv();
    const aTok = await login(env, 'alice', 'd-a');
    const bTok = await login(env, 'bob', 'd-b');

    const cr = await handleCreateBot(
      await authedReq('/api/bots', 'POST', aTok, { name: 'alice-only' }),
      env,
      null,
    );

    const r = await handleRevokeBot(
      await authedReq(`/api/bots/${cr.body.bot_id}/revoke`, 'POST', bTok),
      env,
      cr.body.bot_id,
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_your_bot');
  });

  it('is idempotent on a second revoke', async () => {
    const env = makeEnv();
    const token = await login(env, 'alice', 'd-a');
    const cr = await handleCreateBot(
      await authedReq('/api/bots', 'POST', token, { name: 'x' }),
      env,
      null,
    );

    const r1 = await handleRevokeBot(
      await authedReq(`/api/bots/${cr.body.bot_id}/revoke`, 'POST', token),
      env,
      cr.body.bot_id,
    );
    expect(r1.status).toBe(200);
    const r2 = await handleRevokeBot(
      await authedReq(`/api/bots/${cr.body.bot_id}/revoke`, 'POST', token),
      env,
      cr.body.bot_id,
    );
    expect(r2.status).toBe(200);
    expect(r2.body.already_revoked).toBe(true);
  });
});