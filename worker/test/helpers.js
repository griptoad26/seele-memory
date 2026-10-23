/**
 * test/helpers.js — shared helpers for the security-relevant test paths.
 *
 * WHY THIS EXISTS (TASK-seele-cloud-20261022-101)
 *
 * POST /api/keys/register used to take `user_id` from the request body,
 * so every test could invent a tenant by string. That is exactly the
 * cross-tenant impersonation bug: an unauthenticated caller minted a
 * 365-day memory:write token for any user_id it liked.
 *
 * Registration is now gated on Cloudflare Access and derives the tenant
 * from `sha256(cf-access-authenticated-user-email)`. So a test that
 * wants "tenant alice" must ask to BE alice:
 *
 *     const alice = await loginAs(env, 'alice@example.com', 'd-a');
 *     alice.token   // device token whose sub is sha256(alice@example.com)
 *     alice.user_id // that hash
 *
 * The alternative — hand-writing a user_id string into a test — would
 * reintroduce the bug in the test suite. We assert instead that a body
 * claiming a different user_id is ignored; see test/keys.test.js.
 */

/**
 * Derive the tenant id the Worker will compute for an email.
 * Must mirror userIdFromEmail in src/keys.js.
 *
 * @param {string} email
 * @returns {Promise<string>}
 */
export async function userIdFor(email) {
  const norm = String(email).trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Register a device as the holder of an Access email, and return the
 * minted token plus the derived tenant id.
 *
 * @param {any} env                 worker env (needs DB + GRANT_JWT)
 * @param {string} email             the Access identity to authenticate as
 * @param {string} device_id         device id to register
 * @param {object} [opts]
 * @param {string} [opts.user_id]    body user_id to (deliberately) ignore
 * @param {boolean} [opts.withHeader] send the Access header (default true)
 * @returns {Promise<{token: string, user_id: string, email: string, status: number, body: any}>}
 */
export async function loginAs(env, email, device_id, opts = {}) {
  const { handleRegisterDevice } = await import('../src/keys.js');
  const headers = { 'content-type': 'application/json' };
  if (opts.withHeader !== false) {
    headers['cf-access-authenticated-user-email'] = email;
  }
  const body = {
    // If the caller supplied user_id, send it — the handler must ignore
    // it. Keeping it in the payload is what proves the ignore.
    ...(opts.user_id ? { user_id: opts.user_id } : {}),
    device: {
      device_id,
      name: `${device_id}-name`,
      platform: 'linux',
      app_version: '0.10.0-test',
    },
  };
  const req = new Request('https://test/api/keys/register', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const r = await handleRegisterDevice(req, env);
  return {
    status: r.status,
    body: r.body,
    token: r.body && r.body.device_token,
    user_id: await userIdFor(email),
    email,
  };
}

/**
 * Build an authenticated Request for the sync/bot/recall routes.
 *
 * @param {string} url
 * @param {string} method
 * @param {string} token
 * @param {any} [body]
 * @param {Record<string,string>} [extraHeaders]
 */
export function authedReq(url, method, token, body, extraHeaders = {}) {
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(`https://test${url}`, init);
}