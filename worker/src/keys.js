/**
 * src/keys.js — Device registration, revocation, and user-key bootstrap.
 *
 * Routes:
 *   POST /api/keys/register
 *   POST /api/keys/revoke
 *
 * Per the dispatch brief, "device registration → returns device_id + a
 * long-lived device token". A device token is a signed JWT (HS256) bound
 * to (user_id, device_id) with a far longer TTL than bot grants — devices
 * are physical things the user controls, so the convenience of "stay
 * logged in for a year" outweighs the revocation race window for v0.10.0.
 *
 * The user_id comes from CF Access (email-link allowlist →
 * `cf-access-authenticated-user-email` header) and NOTHING else. The
 * body-supplied `user_id` is accepted only as a cosmetic echo and is
 * NEVER used for identity.
 *
 * HISTORY / WHY THIS IS FAIL-CLOSED (TASK-seele-cloud-20261022-101):
 * the Phase-1 code read `user_id` from the request body because Access
 * was not yet bound to the workers.dev hostname. That shortcut shipped
 * and stayed after the hostname situation was resolved, so
 * `POST /api/keys/register` was a fully unauthenticated token factory:
 * any caller could mint a 365-day `memory:write` token for ANY tenant
 * and then read/write that tenant's data through /api/sync/*. Adding
 * Cloudflare Access alone would not have closed it — Access gates the
 * front door, but the body user_id still let any allowlisted account
 * enrol itself into a tenant it did not hold. Front door locked,
 * interior open.
 *
 * The identity is derived as `sha256(lowercased email)`, matching the
 * existing `users.email_hash` pattern, so an email address never
 * becomes a primary key or a JWT subject.
 *
 * IMPORTANT privacy note: the `public_key_ed25519` field is stored on the
 * device row. The device's *private* key never leaves the device — it's
 * derived from the user's BIP-39 phrase per SPEC §"Privacy model".
 */

import { upsertUser, upsertDevice, revokeDevice } from './db.js';
import { signGrant } from './auth.js';

// Default device token lifetime: 365 days. SPEC §"Authentication" leaves
// device session lifetime explicitly to the implementation; one year is
// a sane default for a desktop/mobile app the user installs.
const DEFAULT_DEVICE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Decode a base64 string to bytes. Returns null on garbage input rather
 * than throwing — handlers treat malformed keys as a 400.
 *
 * @param {string} s
 */
function decodeMaybe(s) {
  if (typeof s !== 'string' || !s) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * The Cloudflare Access identity header. Cloudflare strips this from
 * client-supplied requests and only sets it for allowlisted identities,
 * which is exactly the trust property we need.
 */
export const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';

/**
 * Derive a stable, non-reversible tenant id from an Access email.
 *
 * `sha256(lowercased email)` — the same shape the schema already uses
 * for `users.email_hash`, so the email never appears in a primary key,
 * a foreign key, or a JWT `sub` claim.
 *
 * @param {string} email
 * @returns {Promise<string>} 64-char lowercase hex
 */
export async function userIdFromEmail(email) {
  const norm = String(email).trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Resolve the caller's identity from the Access header. Fail closed.
 *
 * Returns `{ ok: false, status: 401 }` when the header is absent or
 * blank. There is deliberately no fallback to a body-supplied user_id:
 * that fallback is the vulnerability.
 *
 * @param {Request} request
 * @returns {Promise<{ok: true, email: string, user_id: string}
 *                 | {ok: false, status: number, body: object}>}
 */
export async function accessIdentity(request) {
  const email = request.headers.get(ACCESS_EMAIL_HEADER);
  if (typeof email !== 'string' || !email.trim()) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'access_required',
        message:
          `Missing '${ACCESS_EMAIL_HEADER}'. Device registration requires a ` +
          'Cloudflare Access identity; `user_id` is derived from that header ' +
          'and cannot be supplied by the caller.',
      },
    };
  }
  const norm = email.trim().toLowerCase();
  return { ok: true, email: norm, user_id: await userIdFromEmail(norm) };
}

/**
 * Handle POST /api/keys/register.
 *
 * Body:
 *   {
 *     email_hash?:       string,           // optional; IGNORED for identity
 *     public_key?:       string (base64),  // optional; user's master pubkey
 *     user_id?:          string,           // optional; IGNORED (see above)
 *     device: { ... }
 *   }
 *
 * The caller-supplied `user_id` is IGNORED. Identity is
 * `sha256(cf-access-authenticated-user-email)`.
 *
 * Response 200:
 *   {
 *     user_id:     string,
 *     device_id:   string,
 *     device_token: string,            // JWT for subsequent calls
 *     token_type:  'Bearer',
 *     expires_at:  ISO-8601,
 *     scope:       'memory:write',     // devices get full scope by default
 *   }
 *
 * @param {Request} request
 * @param {{ DB: any, GRANT_JWT?: string }} env
 */
export async function handleRegisterDevice(request, env) {
  // --- FAIL CLOSED FIRST -------------------------------------------------
  // Identity comes from Cloudflare Access and nowhere else. No header,
  // no token. This runs before any body parsing so a malformed body
  // can't be used to probe the endpoint.
  const identity = await accessIdentity(request);
  if (!identity.ok) return { status: identity.status, body: identity.body };
  const user_id = identity.user_id;

  const body = await safeJson(request);
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'JSON body required' } };
  }
  // `user_id` and `email_hash` from the body are deliberately ignored.
  // See the history note at the top of this file.
  const { device, public_key } = body;
  if (!device || typeof device !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: '`device` object is required' } };
  }
  for (const f of ['device_id', 'name', 'platform', 'app_version']) {
    if (typeof device[f] !== 'string' || !device[f]) {
      return { status: 400, body: { error: 'bad_request', message: `\`device.${f}\` is required` } };
    }
  }

  const userPub = decodeMaybe(public_key);
  if (public_key != null && !userPub) {
    return { status: 400, body: { error: 'bad_request', message: '`public_key` must be base64' } };
  }
  const devPub = decodeMaybe(device.public_key);
  if (device.public_key != null && !devPub) {
    return { status: 400, body: { error: 'bad_request', message: '`device.public_key` must be base64' } };
  }

  // Bootstrap the user row. email_hash is the same hash as the user_id,
  // so the users table satisfies NOT NULL without ever storing an email.
  try {
    await upsertUser(env.DB, {
      user_id,
      email_hash: user_id,
      public_key_ed25519: userPub || new Uint8Array(32), // empty placeholder
    });
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }

  try {
    await upsertDevice(env.DB, {
      device_id: device.device_id,
      user_id,
      name: device.name,
      platform: device.platform,
      app_version: device.app_version,
      public_key_ed25519: devPub,
      subkey_id: typeof device.subkey_id === 'string' && device.subkey_id
        ? device.subkey_id
        : device.device_id,
    });
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }

  // Mint a long-lived device token. `sub` is the Access-derived user_id
  // (see accessIdentity above), so the token is bound to the identity the
  // caller actually proved — it cannot be minted for another tenant.
  // We require GRANT_JWT to be set; if it isn't, the deploy was
  // incomplete — fail loudly so we don't ship a Worker that silently
  // hands out unsigned tokens.
  if (!env.GRANT_JWT) {
    return {
      status: 500,
      body: {
        error: 'misconfigured',
        message: 'GRANT_JWT secret is not set; cannot mint device token',
      },
    };
  }

  const { jwt, expires_at } = await signGrant({
    secret: env.GRANT_JWT,
    sub: user_id,
    bot_id: device.device_id, // devices piggyback on bot_id for the JWT
    scope: 'memory:write',
    ttl_seconds: DEFAULT_DEVICE_TOKEN_TTL_SECONDS,
    issuer: 'seele-cloud:device',
  });

  return {
    status: 200,
    body: {
      user_id,
      device_id: device.device_id,
      device_token: jwt,
      token_type: 'Bearer',
      expires_at,
      scope: 'memory:write',
    },
  };
}

/**
 * Handle POST /api/keys/revoke.
 *
 * Body: { device_id: string }
 *
 * A device token is valid for 365 days, so without revocation any leak
 * is permanent. This is the compensating control: marking the device
 * revoked makes `verifyGrant` reject its token immediately, regardless
 * of how much TTL is left.
 *
 * Authorization uses the SAME Access identity as registration — the
 * caller's header-derived user_id is the only identity accepted, and
 * the device must belong to it. There is no body-supplied `user_id`.
 * A caller therefore cannot revoke another tenant's device by naming
 * it.
 *
 * Response 200: { ok: true, user_id, device_id, revoked_at }
 * Response 404: device_id not present, not owned by the caller, or
 *              already revoked (indistinguishable by design — leaking
 *              "exists but belongs to someone else" would be an
 *              enumeration oracle).
 */
export async function handleRevokeDevice(request, env) {
  const identity = await accessIdentity(request);
  if (!identity.ok) return { status: identity.status, body: identity.body };
  const user_id = identity.user_id;

  const body = await safeJson(request);
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'JSON body required' } };
  }
  const device_id = body.device_id;
  if (typeof device_id !== 'string' || !device_id) {
    return { status: 400, body: { error: 'bad_request', message: '`device_id` is required' } };
  }

  let result;
  try {
    result = await revokeDevice(env.DB, { user_id, device_id });
  } catch (err) {
    return { status: 500, body: { error: 'db_error', message: String((err && err.message) || err) } };
  }

  if (!result || !result.revoked) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: 'No active device with that id for this identity',
      },
    };
  }

  return {
    status: 200,
    body: { ok: true, user_id, device_id, revoked_at: result.revoked_at },
  };
}

/**
 * Best-effort JSON parse. Returns null on any failure (including empty
 * body or wrong content-type) so the handler can return a clean 400.
 *
 * @param {Request} request
 */
async function safeJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}