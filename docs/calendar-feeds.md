# Calendar feeds

Subscribe to a log from Google Calendar, Apple Calendar, or Thunderbird. Feeds
are read-only, generated from the log's accepted events, and served by a
dedicated public Worker on its own origin, so they are reachable without a
Cloudflare Access browser session and the site itself has no Access bypass.

## Creating and revoking a feed

1. Open **Calendar** and choose **Feeds** in the toolbar.
2. Choose **New feed**, give it a label, pick the publish window (default:
   6 months back, 18 months ahead), and choose the sources to publish (grouped
   rows such as Events, Transactions, and Invoices; all selected by
   default; at least one is required).
3. **Create feed** shows the URL **once**. Copy it immediately; only the
   token's SHA-256 is stored, so it cannot be shown again. On Apple devices,
   *Add to Apple Calendar* opens the `webcal://` link directly.
4. Paste the URL into the calendar client's "Subscribe by URL" flow.
5. Reopen **Feeds** to review or **Revoke** a feed. The one-time URL is
   cleared when the drawer closes.

Notes:

- One token per feed registration; a log can have several feeds with different
  source filters and windows.
- Feeds publish accepted events only. Locally pending or later-rejected events
  never reach Ledger, so a feed can lag the app by one sync.
- The window bounds what is published; ranges that overlap the window are
  clipped to it.
- `lastAccessedAt` and the creation details are shown in the drawer.
- The Worker has no tenant clock, so window boundaries are computed in UTC;
  a day either side at the edge of the window is possible for non-UTC users.

## Deployment and provisioning

Two Workers share the work, and only one of them is public:

```
calendar app  GET https://<feed origin>/feed/<token>.ics
  -> calendar-public Worker (no Ledger credential, no Access, invocation logs off)
       reads the token's pointer from R2, finds the owning site
  -> service binding SITE_<ID> -> that site's CalendarFeedRenderer entrypoint
       reads Ledger, folds the events, serializes the ICS, caches it in R2
```

- **Management** stays on the site: `/api/calendar-feeds/v1`, Access-protected.
  A new feed's URL is built from `CALENDAR_FEED_ORIGIN`, a non-secret variable
  generated from `tenants.json` (`infrastructure.calendarPublicOrigin`).
- **Pointer:** `v1/tokens/<hash>.json` records `siteId` next to the feed, app
  and log. The feed Worker maps `siteId` to a binding name by a fixed rule
  (`siteBindingName`), so a pointer can only select a configured site.
- **Storage:** `CALENDAR_FEEDS` (R2) stores pointers, feed records, and the ICS
  cache; the feed Worker only reads it. `pnpm ensure:tenant` creates the
  `st-calendar-feeds` bucket.
- **Feed Worker config** is generated, not hand-written:
  `hearthlog build` writes `.generated/shared/calendar-public/` (and
  `.generated/sites/<id>/calendar-public/` for a site on its own stack): the
  `wrangler.jsonc`, the entry file, and a `tsconfig.json`, with one renderer
  binding per site on that stack.
  `pnpm calendar:public:check` type-checks it, `calendar:public:dry-run`
  bundles it, `calendar:public:smoke` probes the anonymous route.
- **Deploy order:** the site Workers first (they export the renderer the feed
  Worker binds), then the feed Worker. `deploy.yml` does this in
  `deploy-calendar-public`, after `deploy-tenants`.
- **Access:** the feed Worker's workers.dev hostname is not covered by any Access
  application, which is what makes it reachable. `ensure:tenant` deletes the
  path-scoped `host/api/calendar-feed/*` Bypass application that earlier
  versions created on each site.
- **Ledger:** feeds read the log over the site's service binding with its
  `LEDGER_AUTH_TOKEN`; that credential never leaves the site Worker.

### Moving from the old path

Feeds used to be served at `/api/calendar-feed/<token>.ics` on the site. That
route is gone. Existing feeds do not resolve on the new Worker, because their
pointers have no `siteId`: open **Feeds**, revoke them, create them again and
resubscribe with the new URL. Event UIDs are unchanged (they carry the site's
own hostname, not the feed host), so a calendar that is resubscribed to an
equivalent feed shows the same events.

## Security model

- Tokens are 256-bit random values. Only `SHA-256(token)` is stored, and the
  hash is the storage key, so validation is a single strongly consistent GET.
- The URL is a bearer secret: anyone with it can read the published calendar.
  Keep it out of chat logs and screenshots.
- Unknown, revoked, expired, and other-site tokens all return 404 so the route
  does not confirm whether a token exists.
- The feed Worker has observability off and never logs a path, so the token is
  not recorded by the Worker. Cloudflare's own edge analytics still see request
  URLs; that stays accepted.
- Requests are limited per client address by the `FEEDS_LIMITER` rate-limit
  binding (60 a minute), because workers.dev has no zone for WAF rules.
- The feed Worker cannot reach Ledger: a compromise of it exposes the feeds it
  can render, not the Ledger credential.

## Serving behavior

- `GET` returns `text/calendar; charset=utf-8` with an `ETag` of the served
  log version. `HEAD` returns headers only.
- The generated ICS is cached in R2 per `(log, source filter, window, head
  version)`; unchanged logs are served from cache without refetching events.
- Logs larger than the on-demand page budget (about 10k events) return
  `503 calendar_feed_too_large`; reduce the window or source set, or extend
  the budget in `packages/cloudflare/src/calendar-feeds.ts`.
- UIDs are stable per source and record (`<source-key>-<record-id>@<host>`);
  editing a record keeps its UID and updates its content.

## Local development

`pnpm dev` does not run the frontend Worker, so `/api/calendar-feeds/v1` is
unavailable locally; the drawer reports the request failure.
