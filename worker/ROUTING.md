# Why `seele.agency/api/*` does NOT reach this Worker

## The finding (2026-10-19)

`seele.agency` is a **Cloudflare Pages** project (`seele-agency`, account
`4240b199ca30d185e7954e6166582e7c`). Its custom domains are:

    seele-agency.pages.dev
    seele.agency
    www.seele.agency

**Pages custom domains take precedence over Worker routes on the same
hostname.** Requests to `https://seele.agency/api/mem/health` are answered by
the Pages static-asset layer with the marketing landing page HTML — the Worker
never executes, even though its route is registered:

    GET /zones/<zone_id>/workers/routes
      seele.agency/api/* -> seele-memory
      seele.agency/mem/* -> seele-memory

The Worker deploy succeeds and both bindings resolve; the routes simply never
fire because Pages wins the hostname match first. This is expected Cloudflare
behavior, not a misconfiguration on our side.

## The working configuration

The Worker publishes to its own hostname via `workers_dev = true`:

    https://seele-memory.griptoad.workers.dev

This is the **canonical API base URL** until the Pages/Workers conflict is
resolved by one of the routes below. Note the ~90s delay between the deploy
and the edge certificate being issued — the first requests fail with
`sslv3 alert handshake failure` until then.

Consumers (xkg-core `SyncTarget::SeeleCloud`, the Flutter app, the npm SDK)
must point `base_url` at `https://seele-memory.griptoad.workers.dev`.

## Options to reclaim `seele.agency/api/*`

None of these are wrangler-managed; all require a Cloudflare dashboard or DNS
action by the account owner.

1. **Pages Functions (recommended).** Add a `functions/api/[[path]].js` +
   `functions/mem/[[path]].js` layer to the `seele-agency` Pages project that
   forwards matching requests to this Worker's hostname via
   `env.SEELE_MEMORY_API.fetch()`. Keeps the public hostname, requires
   restructuring the deploy so the Worker and Pages ship together.

2. **Move the marketing site off the apex.** Repoint `seele.agency` /
   `www.seele.agency` at a different Pages project (or `www`-only), then
   Worker routes on the apex take effect. Simple, but changes the marketing
   site's hosting topology.

3. **Dedicated API subdomain.** Add a `mem.seele.agency` CNAME to
   `seele-memory.griptoad.workers.dev` and attach the Worker route to that
   hostname. Cheapest option, keeps everything isolated.

4. **Leave as-is.** Accept `seele-memory.griptoad.workers.dev` as the API
   origin permanently. Zero further infrastructure work; the only cost is a
   less pretty hostname.

## Also still pending: Cloudflare Access

Policies bind to `https://seele.agency/api/*` and `https://seele.agency/mem/*`
today. If the API moves to option 3 or 4, the Access self-hosted application
must be re-pointed at the new hostname. See `README.md` for the dashboard
steps.
