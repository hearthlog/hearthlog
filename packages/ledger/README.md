# Ledger Cloudflare Worker

The separate Ledger admin console provides application metrics,
event-log browsing and paginated event inspection using Hearthlog's shared UI components.

`@hearthlog/ledger` (this package) is the sole Ledger runtime; the repository's `ledger/` directory holds the host files for deploying it (`wrangler.jsonc`, the entry that re-exports it, the generated `Env` types, `.dev.vars.example`). An Elysia application owns the stateless
HTTP boundary and invokes two SQLite-backed Durable Object classes through
typed RPC. Elysia's `CloudflareAdapter` is officially experimental.

## Architecture

- `src/index.ts` is the minimal Worker entrypoint and exports `LedgerApp` and
  `AppRegistry` under their deployed class names.
- `src/http.ts` constructs and compiles Elysia. Route-scoped resolvers verify
  administrator credentials or app access claims once and inject the verified
  identity into handlers.
- `src/schemas.ts` is the HTTP DTO and response-model source of truth.
- `AppRegistry` is the deterministic `registry-v1` administrative object. It
  owns unique application names and credential lifecycle metadata.
- One `LedgerApp` object is addressed by each application UUID. It owns logs,
  events, entity claims, idempotency responses, and hibernating WebSockets for
  that application.

Durable Object namespace access is the capability boundary for internal RPC.
The public administrator API still uses a constant-time token comparison.
`LedgerApp.fetch()` accepts only the exact WebSocket upgrade route; ordinary
operations use typed RPC.

Both objects run ordered application-level schema migrations in
`_sql_schema_migrations`. The Cloudflare class names, bindings, exports, and
SQLite storage identities must not be renamed because deployed data is tied to
them.

## Local development

Create `ledger/.dev.vars` from `ledger/.dev.vars.example` without committing
it, replace all placeholders, and start Wrangler:

```bash
pnpm ledger:dev
```

Wrangler listens on `http://127.0.0.1:8787`. Signing keys must contain at least
32 bytes. The local Vite gateway validates the browser's actual origin,
including whichever port Vite selected, and removes it before forwarding.
`ALLOWED_ORIGINS` is only needed for clients that call Ledger directly.

`EVENT_VALIDATION` controls the payload checks on appends. Ledger knows the
shape of every entity event from `pnpm build:generated`
(`.generated/src/event-schemas.generated.ts`, gitignored, built from the core's entity definitions and
those of every module, with `EVENT_OWNERS` naming the module that defines each type): a known event's keys must have the declared
kind and an add must carry its required keys, a type must be known (or look like
a runtime-defined entity's `_ADDED`, `_UPDATED` or `_REMOVED`), and extra keys
are always allowed. In `report` mode (production) a violation is logged as
`Ledger event validation` with the event type and rule, never a value, and the
append is accepted. In `enforce` mode it is rejected with
`422 invalid_event_payload`, which the app records as a rejected local change.

### Moving an application with its identities

`GET /admin/v1/apps/<id>/transfer` streams an application as NDJSON (every log with
its ID, version, hidden state and fork lineage; every event with its ID, version,
timestamp, author and action batch; and the idempotency records that recognize a
retried request). An empty Ledger takes it with `POST /admin/v1/import`, then
`POST /admin/v1/apps/<id>/import` for each chunk of records and
`POST /admin/v1/apps/<id>/import/finish`, which opens the application only when every
log holds the events the source reported. `GET /admin/v1/apps/<id>/checksums` gives one
digest per log on both sides. The application has no token until you mint one
(`rotate-token`), so nothing can write to it half-imported. It moves an application
between Ledgers (for example onto a stack of its own).

**Write fence.** `PUT /admin/v1/apps/<id>/fence` with `{ "mode": "tenant_migrating" }`
pauses every write (append, create, fork, hide, delete) with `503 tenant_migrating` and
`Retry-After`, which clients retry without parking their queue; `{ "mode": "moved",
"destination": "https://…" }` ends it with `410 tenant_moved` naming the new origin;
`{ "mode": "off" }` lifts it. Reads and `GET /session` stay open, and the session reports the
fence so the frontend Worker can pause its own writes (files, publications, feeds, integration
ingest, fork preparation, daily jobs) the same way. A request that waited out the pause and is
retried is recognized by its request id and lands once.

Each application also carries an **event policy** (`GET|PUT /admin/v1/apps/<id>/policy`):
`contracts` lists the modules whose event types it accepts (the core's always are;
`EVENT_OWNERS` in `event-schemas.generated.ts` says which module defines each type),
`dynamicEvents` says whether runtime-defined entity types are allowed, and
`validation` (`report` or `enforce`) overrides the deployment's `EVENT_VALIDATION`.
An application created without a policy gets `{ contracts: null, dynamicEvents: false,
validation: "enforce" }`; `pnpm ensure:tenant` creates a site's application with the
modules the site ships. An application that predates policies has none and behaves
as before; `pnpm ensure:tenant -- --site <id> --apply-policy` sets the site's policy on
it. Changing a policy never re-judges accepted events.
Switch production to `enforce` once the logs show only intended rejections.
A request that was already accepted always replays. Restoring a backup taken
from older clients replays their events through the same checks, so keep
`report` mode while restoring.

In a second terminal, start the frontend:

```bash
pnpm dev
```

Before Vite starts, `pnpm dev` runs `ledger:provision-local`. It verifies an
existing ignored local app credential or provisions one with `ADMIN_TOKEN`
from `ledger/.dev.vars`. Vite then proxies `/api/ledger` HTTP and WebSocket
traffic to this local Worker and injects the app token server-side. Neither the
administrator token nor the app token is bundled into browser code.

## Checks and deployment

```bash
pnpm ledger:types
pnpm ledger:check
pnpm ledger:test
pnpm ledger:dry-run
pnpm test:worker
```

Configure production secrets without committing them:

```bash
pnpm exec wrangler secret put ADMIN_TOKEN --config .generated/shared/ledger/wrangler.jsonc
pnpm exec wrangler secret put TOKEN_SIGNING_KEY_CURRENT --config .generated/shared/ledger/wrangler.jsonc
```

Then deploy:

```bash
pnpm exec wrangler deploy --config .generated/shared/ledger/wrangler.jsonc
```

To rotate signing keys without immediately invalidating existing access
tokens, set the old key and ID as `TOKEN_SIGNING_KEY_PREVIOUS` and
`TOKEN_SIGNING_PREVIOUS_KEY_ID`, deploy the new current key, rotate app tokens,
then remove the previous key after the coordinated window.

## Realtime protocol

The browser opens
`/api/ledger/logs/{logId}/events/socket?afterVersion={cursor}`. The frontend
Worker enforces same-origin access, injects its server-side app credential, and
forwards the upgrade through the Ledger service binding. Ledger verifies that
credential at the Elysia boundary and passes only validated claims to the
target `LedgerApp`.

Sockets are server-to-client only. Catch-up sends ordered `event` frames
followed by `ready`. A gap larger than 512 events or a cursor beyond the head
returns `resync_required`; the client pages through HTTP and reconnects from
the new cursor. Hibernating WebSockets require no application heartbeat.

## Logical export and restore

The Node utility writes a versioned `manifest.json` plus ordered NDJSON pages
of at most 512 events. The manifest and every page carry SHA-256 checksums.
Forks that are still being prepared cannot be read yet, so the export skips
them and lists their IDs as `skippedLogIds`.
Administrators can also download a consistent, streamed JSON snapshot for an
active or revoked app from `GET /admin/v1/apps/{appId}/export`; the snapshot
contains application metadata, logs with their fork lineage, and events but
never authentication credentials or internal idempotency records.

```bash
LEDGER_BASE_URL=https://st-ledger.example.workers.dev \
LEDGER_AUTH_TOKEN=... \
pnpm ledger:export --output ./ledger-export

LEDGER_BASE_URL=https://st-ledger.example.workers.dev \
LEDGER_ADMIN_TOKEN=... \
pnpm ledger:restore --input ./ledger-export --name restored-app
```

Restore validates the complete export before provisioning, creates an empty
target application, replays and verifies every page, rotates the bootstrap
credential, and prints the new token. A failed restore revokes the partial
target.
