/**
 * @seele/memory-client — grants.ts
 *
 * Bot grant JWT handling for seele-cloud.
 *
 * -----------------------------------------------------------------------
 *  AUTH MODEL — read this carefully
 * -----------------------------------------------------------------------
 *
 *  The Worker signs every grant with a server-only HS256 secret
 *  (`GRANT_JWT`). Clients NEVER see this secret. So in practice:
 *
 *    1. Server mints the JWT during `POST /api/bots` (returns
 *       `grant.jwt` with a 15-min default TTL).
 *    2. Client uses the JWT as a Bearer on `/mem/v1/*` calls until
 *       it expires.
 *    3. Client can `verifyGrant()` locally to *claim-check* the JWT
 *       (exp, iss, scope, sub, bot_id) without needing the secret.
 *       That fails loudly on tampering attempts that broke the
 *       structure, but cannot fully reject a forged signature
 *       without the secret.
 *
 *  This is the honest tradeoff. The Worker contract is HS256; we
 *  don't pretend we can verify HS256 client-side without the key.
 *  What we DO provide:
 *
 *    * `verifyGrantClaims()` — claim check, no signature verify.
 *      Useful for early failure (expired JWT? wrong scope?
 *      wrong bot_id?) before the server bounces the request
 *      back as 401/403.
 *
 *    * `signGrantForTests()` — sync helper for test suites that
 *      want to mint a JWT against a known secret and feed it to
 *      a stub server. NOT for production use; the secret is
 *      server-side only.
 *
 *  Future Work: when the Worker switches to RS256/EdDSA, we can
 *  ship a public JWK (the `getPublicJwkForVerification()` stub
 *  below documents the migration). The HS256 shape is v0.10.0.
 *
 * -----------------------------------------------------------------------
 */

import { decodeJwt, jwtVerify, SignJWT } from 'jose'

// ---------------------------------------------------------------------------
// Scope constants — mirrors worker/src/auth.js.
// ---------------------------------------------------------------------------

export const SCOPE_RECALL = 'memory:recall'
export const SCOPE_WRITE = 'memory:write'

/** Default grant lifetime per SPEC §"Open Questions" — 15 minutes. */
export const DEFAULT_GRANT_TTL_SECONDS = 900

/** Per-worker default for device tokens — 365 days. */
export const DEFAULT_DEVICE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60

// ---------------------------------------------------------------------------
// Claim shapes
// ---------------------------------------------------------------------------

export interface GrantClaims {
  /** user_id (the JWT's `sub` claim). */
  readonly sub: string
  /** bot_id assigned by the server. */
  readonly bot_id: string
  /** scope granted — `memory:recall` or `memory:write`. */
  readonly scope: string
  /** unix-seconds expiry. */
  readonly exp: number
  /** unix-seconds issued-at. */
  readonly iat: number
  /** issuer — `seele-cloud`, `seele-cloud:device`, or `seele-cloud:bot`. */
  readonly iss: string
}

export interface VerifyResult {
  ok: boolean
  claims?: GrantClaims
  error?: { code: string; message: string }
}

// ---------------------------------------------------------------------------
// Secret key bridge — never hit `node:crypto`. WebCrypto only.
// ---------------------------------------------------------------------------

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

/**
 * Mints a grant JWT. **Server-side use only** — kept in this SDK so
 * dev tooling and tests can produce tokens. The Worker uses the
 * exact same `signGrant` shape (see worker/src/auth.js).
 *
 * @param args
 *   secret       HS256 shared secret.
 *   sub          user_id.
 *   bot_id       bot or device id.
 *   scope        `memory:recall` or `memory:write`.
 *   ttl_seconds  Default 900 (15 min).
 *   issuer       `seele-cloud` | `seele-cloud:device` | `seele-cloud:bot`.
 */
export async function signGrantForTests(args: {
  secret: string
  sub: string
  bot_id: string
  scope: string
  ttl_seconds?: number
  issuer?: string
}): Promise<{ jwt: string; exp: number; expires_at: string }> {
  if (args.scope !== SCOPE_RECALL && args.scope !== SCOPE_WRITE) {
    throw new Error(`invalid scope: ${args.scope}`)
  }
  const ttl = args.ttl_seconds ?? DEFAULT_GRANT_TTL_SECONDS
  const expSeconds = Math.floor(Date.now() / 1000) + ttl
  const jwt = await new SignJWT({ bot_id: args.bot_id, scope: args.scope })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.sub)
    .setIssuer(args.issuer ?? 'seele-cloud')
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(secretKey(args.secret))
  return {
    jwt,
    exp: expSeconds,
    expires_at: new Date(expSeconds * 1000).toISOString(),
  }
}

/**
 * Local claim-level validation. Does NOT verify the HS256 signature
 * (clients don't have the secret). Use this to fail fast in cases
 * where the server would 401/403 anyway — expired JWTs, wrong
 * scopes, structural problems — without round-tripping the server.
 *
 * For full cryptographic verification, the server is the only
 * honest answer in v0.10.0 (HS256 is intrinsically symmetric).
 */
export function verifyGrantClaims(jwt: string, opts?: { required_scope?: string }): VerifyResult {
  let payload: any
  try {
    payload = decodeJwt(jwt)
  } catch (err) {
    return { ok: false, error: { code: 'jwt_invalid', message: String(err) } }
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: { code: 'invalid_claims', message: 'not an object' } }
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, error: { code: 'missing_sub', message: 'sub (user_id) is required' } }
  }
  if (typeof payload.bot_id !== 'string' || !payload.bot_id) {
    return { ok: false, error: { code: 'missing_bot_id', message: 'bot_id is required' } }
  }
  if (typeof payload.scope !== 'string' || (payload.scope !== SCOPE_RECALL && payload.scope !== SCOPE_WRITE)) {
    return { ok: false, error: { code: 'invalid_scope', message: 'scope must be memory:recall or memory:write' } }
  }
  if (typeof payload.exp !== 'number') {
    return { ok: false, error: { code: 'invalid_exp', message: 'exp must be a number' } }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (payload.exp <= nowSec) {
    return { ok: false, error: { code: 'jwt_expired', message: `expired at ${payload.exp} (now=${nowSec})` } }
  }
  if (opts?.required_scope && !scopeSatisfies(payload.scope as string, opts.required_scope)) {
    return {
      ok: false,
      error: {
        code: 'insufficient_scope',
        message: `scope ${payload.scope} does not satisfy required ${opts.required_scope}`,
      },
    }
  }
  return {
    ok: true,
    claims: {
      sub: payload.sub,
      bot_id: payload.bot_id,
      scope: payload.scope,
      exp: payload.exp,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      iss: typeof payload.iss === 'string' ? payload.iss : 'seele-cloud',
    },
  }
}

/**
 * Cryptographic verification — only available when the caller holds
 * the shared secret. Server-side or in test mode.
 *
 * In production this is only useful for the Worker itself; clients
 * should use `verifyGrantClaims()` for cheap pre-flight checks.
 */
export async function verifyGrant(jwt: string, secret: string, opts?: { required_scope?: string }): Promise<VerifyResult> {
  let payload: any
  try {
    const r = await jwtVerify(jwt, secretKey(secret), { algorithms: ['HS256'] })
    payload = r.payload
  } catch (err: any) {
    const name = (err && err.name) || 'JWTVerifyError'
    const code = mapJoseError(name)
    return { ok: false, error: { code, message: String(err) } }
  }
  // Same structural claims check as `verifyGrantClaims`.
  const structural = verifyGrantClaims(jwt, opts)
  if (!structural.ok) return structural
  // We _also_ returned signature verification — surface the payload's
  // `iat` even if it was missing from the input (jose enforces it).
  return {
    ok: true,
    claims: {
      ...structural.claims!,
      iat: typeof payload.iat === 'number' ? payload.iat : (structural.claims?.iat ?? 0),
      iss: typeof payload.iss === 'string' ? payload.iss : 'seele-cloud',
    },
  }
}

/**
 * Does the granted scope satisfy the required scope?
 * (mirrors worker/src/auth.js — `memory:write` satisfies `memory:recall`).
 */
export function scopeSatisfies(granted: string, required: string): boolean {
  if (granted === required) return true
  if (required === SCOPE_RECALL && granted === SCOPE_WRITE) return true
  return false
}

function mapJoseError(name: string): string {
  switch (name) {
    case 'JWTExpired':
      return 'jwt_expired'
    case 'JWSSignatureVerificationFailed':
      return 'bad_signature'
    case 'JWTClaimValidationFailed':
      return 'claim_invalid'
    case 'JWSInvalid':
    case 'JWTInvalid':
    case 'JWTMalformed':
    default:
      return 'jwt_invalid'
  }
}

// ---------------------------------------------------------------------------
// Future — public JWK.
//
// The Worker currently signs with HS256. If/when it moves to RS256 or
// EdDSA, the SDK will fetch the public JWK from `/.well-known/seele-jwks.json`
// and `verifyGrant()` will be able to do a fully client-side check
// without trusting the server. Until then, this is documented as
// v0.10.0 limitation, not a bug.
//
// The constant below is a placeholder to make the migration obvious
// to anyone scanning the source.
// ---------------------------------------------------------------------------

/**
 * Future migration hook. Returns the public JWK to use for verifying
 * grants — currently throws because the Worker uses HS256 (a shared
 * secret, no public half). When the Worker switches to RS256/EdDSA,
 * this fetches `/.well-known/seele-jwks.json` and caches it.
 */
export async function getPublicJwkForVerification(_baseUrl: string): Promise<never> {
  throw new Error(
    '@seele/memory-client: client-side cryptographic grant verification is not available in v0.10.0 ' +
      '(Worker uses HS256). Use verifyGrantClaims() for structural checks; trust the server for signature.',
  )
}

// ---------------------------------------------------------------------------
// Re-export the low-level sign + verify so dev tooling / scripts can
// build tokens without re-importing `jose`.
// ---------------------------------------------------------------------------

export { SignJWT as _SignJWT, jwtVerify as _jwtVerify }
