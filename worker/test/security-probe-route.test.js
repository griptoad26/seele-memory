/**
 * test/security-probe-route.test.js — route-matching / proxy-routing probe.
 *
 * TASK-seele-cloud-20261116-119.
 *
 * The router normalizes the path with `url.pathname.replace(/\/+$/, '') || '/'`
 * and then compares with exact `===` strings. Anything that does not match
 * exactly falls through to handleFreshProxy(), which forwards the request
 * (including its Authorization header) to a third-party origin.
 *
 * These probes enumerate near-miss spellings of the real routes to find
 * ones that fall through to the proxy while still carrying a Bearer token.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { startLocalWorker } from './local-worker.js';

const SECRET = 'route-probe-secret-0123456789abcdefghijk';
let w;
let upstream;
let captured = [];
let upstreamUrl;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    captured.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  w = await startLocalWorker({ grantJwt: SECRET });
  w.env.ORIGIN_URL = upstreamUrl;
});

afterAll(async () => {
  if (w) await w.stop();
  if (upstream) await new Promise((r) => upstream.close(r));
});

// Every one of these is a near-miss of a real route. Each should either
// be handled by the Worker (JSON 401 etc.) or 404 — but if it reaches the
// upstream, the token leaked.
const nearMisses = [
  '/api/sync/state/',        // trailing slash
  '/api/sync/state/extra',   // extra segment
  '/API/SYNC/STATE',         // case
  '/api/sync/State',         // case
  '/api/sync/state%20',      // encoded space
  '/api/bots/',              // trailing slash
  '/api/bots/extra',
  '/api/mem/health/extra',
  '/mem/v1/recall/extra',
  '/api/keys/register/extra',
  '/api//sync/state',        // double slash
];

describe('PROBE 11 — near-miss route spellings that reach the proxy', () => {
  for (const p of nearMisses) {
    it(`GET ${p}`, async () => {
      captured = [];
      const r = await w.request(p, { method: 'GET', token: 'SECRET-TOKEN-XYZ' });
      const leaked = captured.some((c) => c.headers['authorization'] === 'Bearer SECRET-TOKEN-XYZ');
      console.log(
        `  ${leaked ? 'LEAK ' : 'ok   '} ${p} -> status=${r.status} upstream_hits=${captured.length}`,
      );
      // No near-miss spelling may leak the token to the upstream.
      expect(leaked).toBe(false);
    });
  }
});

describe('PROBE 12 — proxy response handling', () => {
  it('the proxy does not reflect upstream Set-Cookie back to the client', async () => {
    const cookieServer = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': 'upstream_session=abc123; Path=/',
      });
      res.end('ok');
    });
    await new Promise((r) => cookieServer.listen(0, '127.0.0.1', r));
    w.env.ORIGIN_URL = `http://127.0.0.1:${cookieServer.address().port}`;
    const r = await w.request('/anything', { method: 'GET' });
    expect(r.headers.get('set-cookie')).toBeNull();
    await new Promise((r2) => cookieServer.close(r2));
  });
});
