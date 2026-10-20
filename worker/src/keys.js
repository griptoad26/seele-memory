/**
 * src/keys.js — Device registration and user-key bootstrap.
 *
 * Routes:
 *   POST /api/keys/register
 *
 * Per the dispatch brief, "device registration → returns device_id + a
 * long-lived device token". A device token is a signed JWT (HS256) bound
 * to (user_id, device_id) with a far longer TTL than bot grants — devices
 * are physical things the user controls, so the convenience of "stay
 * logged in for a year" outweighs the revocation race window for v0.10.0.
 *
 * The user_id comes from CF Access in production (email-link allowlist →
 * `cf-access-authenticated-user-email` header). For v0.10.0 we accept
 * the user_id directly in the request body because Access is not yet
 * attached to the workers.dev hostname — see /tmp/seele-memory/worker/
 * ROUTING.md for the hostname situation. The brief and SPEC both treat
 * this as Phase 1 acceptance; we don't gate on Access here.
 *
 * IMPORTANT privacy note: the `public_key_ed25519` field is stored on the
 * device row. The device's *private* key never leaves the device — it's
 * derived from the user's BIP-39 phrase per SPEC §"Privacy model".
 */

import { upsertUser, upsertDevice } from './db.js';
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
 * Handle POST /api/keys/register.
 *
 * Body:
 *   {
 *     user_id:           string,           // required
 *     email_hash?:       string,           // optional; used for users table
 *     public_key?:       string (base64),  // optional; user's master pubkey
 *     device: {
 *       device_id:         string,         // required, UUID-v4
 *       name:              string,         // required, e.g. "xkg-desktop-mbp"
 *       platform:          string,         // required, e.g. "macos", "linux"
 *       app_version:       string,         // required, e.g. "0.10.0"
 *       public_key?:       string (base64),// optional; per-device pubkey
 *       subkey_id?:        string,         // optional; defaults to device_id
 *     }
 *   }
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
  const body = await safeJson(request);
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'bad_request', message: 'JSON body required' } };
  }
  const { user_id, device, email_hash, public_key } = body;
  if (typeof user_id !== 'string' || !user_id) {
    return { status: 400, body: { error: 'bad_request', message: '`user_id` is required' } };
  }
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

  // Bootstrap the user row. We tolerate the user_id being new (first sync
  // from a brand-new device) — email_hash defaults to user_id if absent
  // so we always satisfy the NOT NULL constraint.
  try {
    await upsertUser(env.DB, {
      user_id,
      email_hash: typeof email_hash === 'string' && email_hash ? email_hash : user_id,
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

  // Mint a long-lived device token. We require GRANT_JWT to be set; if
  // it isn't, the deploy was incomplete — fail loudly so we don't ship
  // a Worker that silently hands out unsigned tokens.
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