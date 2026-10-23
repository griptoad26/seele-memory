/**
 * src/auth.js — Grant JWT validation for the bot recall API.
 *
 * SPEC §"Authentication" specifies that bots present an `Authorization:
 * Bearer <grant_jwt>` header on recall calls. The JWT is signed with the
 * shared `GRANT_JWT` secret (a Cloudflare *secret*, not a var, so it's
 * never readable from the dashboard and never appears in `wrangler.toml`).
 *
 * Required claims:
 *   sub     — user_id (string)
 *   bot_id  — string
 *   scope   — one of `memory:recall`, `memory:write`
 *   exp     — unix-seconds expiry; SPEC default is 900s (15 min)
 *
 * Verification flow:
 *   1. Pull the Bearer token from the header, returning 401 if absent
 *      or malformed.
 *   2. `jwtVerify` against the shared secret. `jose` rejects expired,
 *      wrong-signature, and tampered tokens; we surface those as 401
 *      with a stable `error.code`.
 *   3. Cross-check the (sub, bot_id) against the bots table in D1 —
 *      a bot that has been revoked since the grant was minted must
 *      not be honored even if the JWT is otherwise valid.
 *
 * The "memory:write" scope is broader than "memory:recall"; we enforce
 * a strict equality check so a future "memory:admin" scope can't
 * accidentally widen access.
 *
 * IMPORTANT: this module returns structured error objects, never throws
 * to callers. The handler turns the structured error into the right
 * HTTP status (401 for missing/invalid/expired, 403 for wrong-scope,
 * 403 for revoked bot).
 */

import { jwtVerify, SignJWT } from 'jose';
import { checkDeviceRevoked } from './db.js';

// ---------------------------------------------------------------------------
// Scope constants — kept here so handlers can reference them without
// duplicating string literals.
// ---------------------------------------------------------------------------

export const SCOPE_RECALL = 'memory:recall';
export const SCOPE_WRITE = 'memory:write';

const ALL_SCOPES = new Set([SCOPE_RECALL, SCOPE_WRITE]);

// Default grant lifetime per SPEC §"Open Questions" — 15 minutes.
export const DEFAULT_GRANT_TTL_SECONDS = 900;

// ---------------------------------------------------------------------------
// Errors — handler maps these to HTTP status codes.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AuthError
 * @property {string} code     machine-readable error code
 * @property {string} message  human-readable
 * @property {number} status   HTTP status the handler should return
 */

/** @returns {AuthError} */
export function authError(code, message, status) {
  return { code, message, status };
}

// ---------------------------------------------------------------------------
// JWT signing — used by /api/bots (POST) to mint a fresh grant.
// ---------------------------------------------------------------------------

/**
 * Build a Uint8Array from a secret string (env-bound or test-supplied).
 *
 * @param {string} secret
 */
function secretKey(secret) {
  return new TextEncoder().encode(secret);
}

/**
 * Sign a grant JWT. The signature is HS256 with the shared secret.
 *
 * @param {{
 *   secret: string,
 *   sub: string,
 *   bot_id: string,
 *   scope: string,
 *   ttl_seconds?: number,
 *   issuer?: string,
 * }} args
 * @returns {Promise<{ jwt: string, exp: number, expires_at: string }>}
 */
export async function signGrant({
  secret,
  sub,
  bot_id,
  scope,
  ttl_seconds = DEFAULT_GRANT_TTL_SECONDS,
  issuer = 'seele-cloud',
}) {
  if (!ALL_SCOPES.has(scope)) {
    throw new Error(`invalid scope: ${scope}`);
  }
  const expSeconds = Math.floor(Date.now() / 1000) + ttl_seconds;
  const jwt = await new SignJWT({ bot_id, scope })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(secretKey(secret));
  return {
    jwt,
    exp: expSeconds,
    expires_at: new Date(expSeconds * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// JWT verification — used by every authenticated handler.
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token from a header value.
 * Returns null if absent or malformed.
 *
 * @param {string | null | undefined} header
 * @returns {string | null}
 */
export function bearerToken(header) {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return m ? m[1] : null;
}

/**
 * Verify a grant JWT end-to-end. Returns either:
 *   { ok: true, claims } — claims is the verified JWT payload (sub, bot_id,
 *                          scope, exp, iat, iss) plus nothing extra.
 *   { ok: false, error } — structured AuthError.
 *
 * @param {{
 *   secret: string,
 *   authorization: string | null,
 *   required_scope?: string,
 *   db?: any,                     // optional D1 binding — when supplied we
 *                                  // also check the bot hasn't been revoked.
 * }} args
 */
export async function verifyGrant({ secret, authorization, required_scope, db }) {
  const token = bearerToken(authorization);
  if (!token) {
    return {
      ok: false,
      error: authError(
        'missing_bearer',
        'Authorization: Bearer <grant_jwt> header is required',
        401,
      ),
    };
  }

  let payload;
  try {
    const result = await jwtVerify(token, secretKey(secret), {
      algorithms: ['HS256'],
    });
    payload = result.payload;
  } catch (err) {
    // jose throws specific named errors; we map the common ones to
    // stable codes the SDK can pattern-match on.
    const name = (err && err.name) || 'JWTVerifyError';
    const code = mapJoseError(name);
    return {
      ok: false,
      error: authError(code, String((err && err.message) || err), 401),
    };
  }

  // Required claims check. jose only enforces `exp` automatically.
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      error: authError('invalid_claims', 'JWT payload is not an object', 401),
    };
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    return {
      ok: false,
      error: authError('missing_sub', 'JWT claim `sub` (user_id) is required', 401),
    };
  }
  if (typeof payload.bot_id !== 'string' || !payload.bot_id) {
    return {
      ok: false,
      error: authError('missing_bot_id', 'JWT claim `bot_id` is required', 401),
    };
  }
  if (typeof payload.scope !== 'string' || !ALL_SCOPES.has(payload.scope)) {
    return {
      ok: false,
      error: authError('invalid_scope', `JWT claim scope must be one of ${[...ALL_SCOPES].join(', ')}`, 401),
    };
  }

  // Required-scope gate. A memory:write JWT can do everything memory:recall
  // can; we explicitly accept broader scopes here so handlers can just
  // declare what they need.
  if (required_scope && !scopeSatisfies(payload.scope, required_scope)) {
    return {
      ok: false,
      error: authError(
        'insufficient_scope',
        `JWT scope ${payload.scope} does not satisfy required ${required_scope}`,
        403,
      ),
    };
  }

  // Optional revocation check against D1. If no binding is supplied
  // (tests, or the route doesn't need cross-row context), skip this.
  //
  // Two grant families:
  //
  //   * bot grants (iss != 'seele-cloud:device'): cross-check the bot
  //     row against the JWT's sub and revoked_at.
  //
  //   * device grants (iss == 'seele-cloud:device'): bot_id IS the
  //     device_id. These used to be waved through entirely ("revoking a
  //     device means rotating the token") — which, combined with a
  //     365-day TTL, meant a leaked device token was permanent. Now that
  //     POST /api/keys/revoke exists, we cross-check the device row the
  //     same way. This requires `db` to be passed in; the sync routes
  //     pass env.DB (see the "no db cross-check" note removed below).
  if (db) {
    if (payload.iss === 'seele-cloud:device') {
      const revoked = await checkDeviceRevoked(db, payload.bot_id, payload.sub);
      if (revoked) {
        return {
          ok: false,
          error: authError(
            'device_revoked',
            `device ${payload.bot_id} is revoked or does not belong to ${payload.sub}`,
            401,
          ),
        };
      }
    } else {
      const revoked = await checkRevoked(db, payload.bot_id, payload.sub);
      if (revoked) {
        return {
          ok: false,
          error: authError(
            'bot_revoked',
            `bot ${payload.bot_id} has been revoked or does not belong to ${payload.sub}`,
            403,
          ),
        };
      }
    }
  }

  return {
    ok: true,
    claims: {
      sub: payload.sub,
      bot_id: payload.bot_id,
      scope: payload.scope,
      exp: payload.exp,
      iat: payload.iat,
      iss: payload.iss,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Does the granted scope satisfy the required scope?
 *
 * Right now `memory:write` satisfies `memory:recall` (write implies read).
 * Future scopes can be added to this matrix.
 *
 * @param {string} granted
 * @param {string} required
 */
export function scopeSatisfies(granted, required) {
  if (granted === required) return true;
  if (required === SCOPE_RECALL && granted === SCOPE_WRITE) return true;
  return false;
}

/**
 * Translate a `jose` error name into a stable code.
 * Anything we don't recognize falls through to `jwt_invalid`.
 */
function mapJoseError(name) {
  switch (name) {
    case 'JWTExpired':
      return 'jwt_expired';
    case 'JWSSignatureVerificationFailed':
      return 'bad_signature';
    case 'JWTClaimValidationFailed':
      return 'claim_invalid';
    case 'JWSInvalid':
    case 'JWTInvalid':
    case 'JWTMalformed':
    default:
      return 'jwt_invalid';
  }
}

/**
 * Look up the bot in D1 and confirm it belongs to the JWT's `sub`,
 * and isn't revoked. Returns true iff the bot should NOT be honored.
 *
 * Semantics:
 *   * No row in bots → treat as a non-bot grant (e.g., a device-issued
 *     grant whose bot_id is a device_id). Allow it through; the JWT
 *     itself is signed and bounded by a short TTL.
 *   * Row exists, belongs to a different user → revoke (cross-user).
 *   * Row exists, owned by JWT sub, but revoked_at != null → revoke.
 *   * Row exists, owned by JWT sub, not revoked → ok.
 *
 * @param {D1Database} db
 * @param {string} bot_id
 * @param {string} user_id
 * @returns {Promise<boolean>}
 */
async function checkRevoked(db, bot_id, user_id) {
  if (!db) return false;
  try {
    const row = await db
      .prepare(
        'SELECT user_id, revoked_at FROM bots WHERE bot_id = ?1'
      )
      .bind(bot_id)
      .first();
    if (!row) return false; // unknown bot → not revoked (could be device)
    if (row.user_id !== user_id) return true; // cross-user attempt → revoked
    if (row.revoked_at != null) return true;
    return false;
  } catch (_) {
    // If D1 is misbehaving we *fail closed* — return true so the caller
    // gets a 403. We never want to honor a JWT when we can't verify the
    // revocation state.
    return true;
  }
}