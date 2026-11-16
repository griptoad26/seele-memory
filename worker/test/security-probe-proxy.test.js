/**
 * test/security-probe-proxy.test.js — catch-all proxy credential-forwarding probe.
 *
 * TASK-seele-cloud-20261116-119.
 *
 * The Worker falls through to handleFreshProxy() for any path it does not
 * explicitly route. handleFreshProxy() builds `new Headers(request.headers)`
 * and fetches an upstream ORIGIN_URL — so every inbound header, including
 * `Authorization: Bearer <device_token>` and the Cloudflare Access identity
 * header, is copied verbatim to the upstream origin.
 *
 * These probes make the upstream a local capture server so we can observe
 * exactly what leaves the Worker.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { startLocalWorker } from './local-worker.js';

const SECRET = 'proxy-probe-secret-0123456789abcdefghij';
let w;
let upstream;
let captured = [];
let upstreamUrl;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    captured.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  upstreamUrl = `http://127.0.0.1:${port}`;

  w = await startLocalWorker({ grantJwt: SECRET });
  // Point the Worker's proxy origin at our local capture server.
  w.env.ORIGIN_URL = upstreamUrl;
});

afterAll(async () => {
  if (w) await w.stop();
  if (upstream) await new Promise((r) => upstream.close(r));
});

describe('PROBE 9 — catch-all proxy forwards credentials upstream', () => {
  it('does NOT forward an Authorization bearer token to the upstream origin', async () => {
    captured = [];
    const r = await w.request('/some/unmatched/path', {
      method: 'GET',
      token: 'super-secret-device-token-value',
    });
    expect(r.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    const c = captured[captured.length - 1];
    // Pre-fix this was 'Bearer super-secret-device-token-value'.
    // The proxy is a content proxy; it must not carry credentials.
    expect(c.headers['authorization']).toBeUndefined();
  });

  it('does NOT forward the Cloudflare Access identity header upstream', async () => {
    captured = [];
    await w.request('/another/unmatched/path', {
      method: 'GET',
      headers: { 'cf-access-authenticated-user-email': 'alice@example.com' },
    });
    const c = captured[captured.length - 1];
    expect(c.headers['cf-access-authenticated-user-email']).toBeUndefined();
  });

  it('does NOT forward cookie headers upstream', async () => {
    captured = [];
    await w.request('/another/unmatched/path', {
      method: 'GET',
      headers: { cookie: 'session=secret' },
    });
    const c = captured[captured.length - 1];
    expect(c.headers['cookie']).toBeUndefined();
  });

  it('does NOT forward x-seele-key upstream', async () => {
    captured = [];
    await w.request('/another/unmatched/path', {
      method: 'GET',
      headers: { 'x-seele-key': 'secret-key-value' },
    });
    const c = captured[captured.length - 1];
    expect(c.headers['x-seele-key']).toBeUndefined();
  });

  it('unmatched /api/* paths are 404, not proxied', async () => {
    captured = [];
    const r = await w.request('/api/keys/rotate', {
      method: 'GET',
      token: 'tok',
    });
    expect(r.status).toBe(404);
    expect(captured.length).toBe(0);
  });

  it('unmatched /mem/* paths are 404, not proxied', async () => {
    captured = [];
    const r = await w.request('/mem/v1/admin', {
      method: 'GET',
      token: 'tok',
    });
    expect(r.status).toBe(404);
    expect(captured.length).toBe(0);
  });

  it('unmatched POST paths fail closed at the proxy (no body forwarded)', async () => {
    captured = [];
    const r = await w.request('/api/keys/rotate', {
      method: 'POST',
      token: 'tok',
      body: { device_id: 'd' },
    });
    // The Worker can't stream a body without `duplex`, so the proxy
    // errors rather than forwarding. Either way: no body leak.
    expect(r.status).toBe(404);
    expect(captured.length).toBe(0);
  });

  it('proxies the root path', async () => {
    captured = [];
    const r = await w.request('/', { method: 'GET' });
    expect(r.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
  });
});
