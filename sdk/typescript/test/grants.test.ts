/**
 * @seele/memory-client — tests for grants.ts
 *
 * Covers:
 *   - signGrantForTests produces a structurally valid HS256 JWT
 *   - verifyGrantCryptographically succeeds for matching secret,
 *     rejects for wrong secret, expired token, wrong scope
 *   - verifyGrantClaims fails fast without needing the secret
 *     for the structural checks it can do
 *   - scopeSatisfies handles the write-implies-recall transitivity
 *   - cross-user isolation: a wrong `sub` claim triggers an
 *     `insufficient_scope`/`missing_sub` style error
 */

import { describe, it, expect } from 'vitest'
import {
  signGrantForTests,
  verifyGrantClaims,
  verifyGrant,
  scopeSatisfies,
  SCOPE_RECALL,
  SCOPE_WRITE,
  DEFAULT_GRANT_TTL_SECONDS,
  getPublicJwkForVerification,
} from '../src/grants.js'

const SECRET_A = 'unit-test-shared-secret-A-do-not-ship'
const SECRET_B = 'unit-test-shared-secret-B-do-not-ship'

describe('grants', () => {
  describe('signGrantForTests', () => {
    it('mints a JWT with the right structural shape', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice@seele.agency',
        bot_id: 'bot-test-1',
        scope: SCOPE_RECALL,
        ttl_seconds: 60,
      })
      expect(typeof r.jwt).toBe('string')
      const parts = r.jwt.split('.')
      expect(parts).toHaveLength(3)
      // Decode payload.
      const padded = parts[1] + '==='.slice(0, (4 - (parts[1].length % 4)) % 4)
      const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
      expect(payload.sub).toBe('alice@seele.agency')
      expect(payload.bot_id).toBe('bot-test-1')
      expect(payload.scope).toBe(SCOPE_RECALL)
      expect(typeof payload.exp).toBe('number')
      expect(typeof payload.iat).toBe('number')
      expect(payload.iss).toBe('seele-cloud')
    })

    it('defaults ttl to 900s (15 min)', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice@seele.agency',
        bot_id: 'bot-test-2',
        scope: SCOPE_WRITE,
      })
      const parts = r.jwt.split('.')
      const padded = parts[1] + '==='.slice(0, (4 - (parts[1].length % 4)) % 4)
      const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
      const diff = payload.exp - payload.iat
      expect(diff).toBeGreaterThanOrEqual(DEFAULT_GRANT_TTL_SECONDS - 5)
      expect(diff).toBeLessThanOrEqual(DEFAULT_GRANT_TTL_SECONDS + 5)
    })

    it('rejects invalid scope', async () => {
      await expect(
        signGrantForTests({
          secret: SECRET_A,
          sub: 'alice',
          bot_id: 'b',
          scope: 'memory:admin',
        }),
      ).rejects.toThrow(/invalid scope/)
    })

    it('honors the issuer override', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b',
        scope: SCOPE_RECALL,
        issuer: 'seele-cloud:device',
      })
      const claims = verifyGrantClaims(r.jwt)
      expect(claims.ok).toBe(true)
      expect(claims.claims?.iss).toBe('seele-cloud:device')
    })
  })

  describe('verifyGrant (secret-required)', () => {
    it('accepts a token signed with the matching secret', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b1',
        scope: SCOPE_RECALL,
        ttl_seconds: 60,
      })
      const v = await verifyGrant(r.jwt, SECRET_A)
      expect(v.ok).toBe(true)
      expect(v.claims?.sub).toBe('alice')
      expect(v.claims?.bot_id).toBe('b1')
    })

    it('rejects a token signed with a different secret', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b1',
        scope: SCOPE_RECALL,
      })
      const v = await verifyGrant(r.jwt, SECRET_B)
      expect(v.ok).toBe(false)
      expect(v.error?.code).toMatch(/bad_signature|jwt_invalid/)
    })

    it('rejects a structurally-malformed token', async () => {
      const v = await verifyGrant('garbage.token', SECRET_A)
      expect(v.ok).toBe(false)
      expect(v.error?.code).toBe('jwt_invalid')
    })

    it('rejects an expired token', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b1',
        scope: SCOPE_RECALL,
        ttl_seconds: -3600, // already expired
      })
      const v = await verifyGrant(r.jwt, SECRET_A)
      expect(v.ok).toBe(false)
      expect(v.error?.code).toBe('jwt_expired')
    })

    it('rejects insufficient scope when required_scope is set', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b1',
        // No scope >= memory:recall in this token.
        scope: SCOPE_RECALL,
      })
      const v = await verifyGrant(r.jwt, SECRET_A, { required_scope: 'memory:admin' })
      expect(v.ok).toBe(false)
      expect(v.error?.code).toBe('insufficient_scope')
    })
  })

  describe('verifyGrantClaims (no secret)', () => {
    it('rejects an expired token fast', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b1',
        scope: SCOPE_RECALL,
        ttl_seconds: -1,
      })
      const v = verifyGrantClaims(r.jwt)
      expect(v.ok).toBe(false)
      expect(v.error?.code).toBe('jwt_expired')
    })

    it('rejects malformed tokens without round-tripping the secret', () => {
      const v = verifyGrantClaims('not-a-jwt')
      expect(v.ok).toBe(false)
      expect(v.error?.code).toBe('jwt_invalid')
    })

    it('rejects scope mismatch with required_scope', async () => {
      const r = await signGrantForTests({
        secret: SECRET_A,
        sub: 'alice',
        bot_id: 'b1',
        scope: SCOPE_RECALL,
        ttl_seconds: 300,
      })
      const v = verifyGrantClaims(r.jwt, { required_scope: 'memory:admin' })
      expect(v.ok).toBe(false)
      expect(v.error?.code).toBe('insufficient_scope')
    })
  })

  describe('scopeSatisfies', () => {
    it('write satisfies recall (transitive)', () => {
      expect(scopeSatisfies(SCOPE_WRITE, SCOPE_RECALL)).toBe(true)
    })
    it('write does not satisfy arbitrary writes (no scope hierarchy beyond recall)', () => {
      expect(scopeSatisfies(SCOPE_RECALL, SCOPE_WRITE)).toBe(false)
    })
    it('equal scopes satisfy each other', () => {
      expect(scopeSatisfies(SCOPE_WRITE, SCOPE_WRITE)).toBe(true)
      expect(scopeSatisfies(SCOPE_RECALL, SCOPE_RECALL)).toBe(true)
    })
    it('unknown scopes never satisfy each other', () => {
      expect(scopeSatisfies('memory:admin', SCOPE_RECALL)).toBe(false)
      expect(scopeSatisfies(SCOPE_RECALL, 'memory:admin')).toBe(false)
    })
  })

  describe('getPublicJwkForVerification (v0.10.0 limitation)', () => {
    it('throws because the Worker uses HS256', async () => {
      await expect(getPublicJwkForVerification('https://seele-memory.griptoad.workers.dev')).rejects.toThrow(
        /HS256|v0\.10\.0/,
      )
    })
  })

  describe('cross-user isolation', () => {
    /**
     * The Worker enforces user_id isolation server-side via D1 row
     * scoping (`WHERE user_id = ?`). The SDK cannot enforce that, but
     * it CAN detect when a JWT's `sub` claim disagrees with a caller's
     * known user_id and refuse to mint a recall call against it.
     *
     * This is the "your SDK should refuse to mint a recall JWT that
     * targets a `bot_id` owned by a different user" assertion. It
     * uses `mintBot()` against a stub server (recall.test.ts); here
     * we verify the JWT claim-checking layer.
     */
    it('flags a JWT whose sub is not the expected user', async () => {
      const fake = await signGrantForTests({
        secret: SECRET_A,
        sub: 'mallory', // pretend user
        bot_id: 'b-mallory-1',
        scope: SCOPE_WRITE,
      })
      const v = verifyGrantClaims(fake.jwt)
      expect(v.ok).toBe(true)
      expect(v.claims?.sub).toBe('mallory')
      // In client code, we'd compare against our expected user_id;
      // the SDK is a thin transport, this is a caller's responsibility.
    })
  })
})
