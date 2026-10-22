# Ledger Cloudflare Worker

The separate Ledger admin console provides application metrics,
event-log browsing and paginated event inspection using Hearthlog's shared UI components.

`@hearthlog/ledger` (this package) is the sole Ledger runtime; the development site's `dev/ledger/` directory holds what running it there needs (the generated `Env` types, the secrets declaration, `.dev.vars.example`); its `wrangler.jsonc` and the entry that re-exports it are generated into `dev/.generated/shared/ledger/`. An Elysia application owns the stateless
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

Create `dev/ledger/.dev.vars` from `dev/ledger/.dev.vars.example` without committing
it, replace all placeholders, and start Wrangler:

```bash
pnpm -C dev ledger:dev
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
validation: "enforce" }`; `pnpm -C dev ensure:tenant` creates a site's application with the
modules the site ships. An application that predates policies has none and behaves
as before; `pnpm -C dev ensure:tenant -- --site <id> --apply-policy` sets the site's policy on
it. Changing a policy never re-judges accepted events.
Switch production to `enforce` once the logs show only intended rejections.
A request that was already accepted always replays. Restoring a backup taken
from older clients replays their events through the same checks, so keep
`report` mode while restoring.

In a second terminal, start the frontend:

```bash
pnpm -C dev dev
```

Before Vite starts, `pnpm -C dev dev` runs `ledger:provision-local`. It verifies an
existing ignored local app credential or provisions one with `ADMIN_TOKEN`
from `dev/ledger/.dev.vars`. Vite then proxies `/api/ledger` HTTP and WebSocket
traffic to this local Worker and injects the app token server-side. Neither the
administrator token nor the app token is bundled into browser code.

## Checks and deployment

```bash
pnpm -C dev ledger:types
pnpm -C dev ledger:check
pnpm -C dev ledger:test
pnpm -C dev ledger:dry-run
pnpm test:worker
```

Configure production secrets without committing them:

```bash
pnpm -C dev exec wrangler secret put ADMIN_TOKEN --config .generated/shared/ledger/wrangler.jsonc
pnpm -C dev exec wrangler secret put TOKEN_SIGNING_KEY_CURRENT --config .generated/shared/ledger/wrangler.jsonc
```

Then deploy:

```bash
pnpm -C dev exec wrangler deploy --config .generated/shared/ledger/wrangler.jsonc
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
pnpm -C dev ledger:export --output ./ledger-export

LEDGER_BASE_URL=https://st-ledger.example.workers.dev \
LEDGER_ADMIN_TOKEN=... \
pnpm -C dev ledger:restore --input ./ledger-export --name restored-app
```

Restore validates the complete export before provisioning, creates an empty
target application, replays and verifies every page, rotates the bootstrap
credential, and prints the new token. A failed restore revokes the partial
target.


## Snapshot baselines and compaction

The existing log history panel has manual **Create snapshot** and **Compact log** controls.
A snapshot captures a complete accepted boundary. Compaction moves its prefix payloads into a private archive;
application/log identities, monotonically increasing event versions, entity claims, action boundaries and retry
receipts stay intact. SQLite retains the compact event identity registry. Historical reads and retries resolve
original payloads from the archive; compaction does not expire history or delete domain records/media.

The generated Ledger configuration binds `LEDGER_ARCHIVE` to `<ledgerWorker>-archive`. Tenant provisioning
ensures that private R2 bucket. Keep it private, without an expiry lifecycle. Deploy compatible code and ensure
this binding before starting maintenance. No namespace or deployed Durable Object identity changes.

Authenticated endpoints under `/logs/:logId`:

- `GET /maintenance`: availability, verified snapshot manifest, storage generation, and current job.
- `GET /maintenance-preview`: the current snapshot/generation and prefix payload counts/bytes for review.
- `POST /maintenance`: `{ requestId, kind: "snapshot" | "compact", expectedCheckpointId?, expectedGeneration? }`.
  Compaction requires the checkpoint ID and generation from the reviewed preview; stale previews fail with 409.
- `POST /maintenance/step`: `{ requestId }`, resumable work using the same request identity.
- `GET /checkpoint?page=N`: one checksum-verified canonical replay chunk and its entity claims.

From the development site, the same operation can run without an open browser:

```bash
pnpm -C dev ledger:maintain --log <log-id> --kind snapshot
pnpm -C dev ledger:maintain --log <log-id> --kind compact
pnpm -C dev ledger:maintain --log <log-id> --resume
```

Set `LEDGER_BASE_URL` and `LEDGER_AUTH_TOKEN` in the process environment; the CLI never prints credentials.
Use `--request-id` to retry an explicit operation and `--once` for one bounded work step.

Jobs persist every source batch and publish only verified snapshots. Canonical snapshots keep original source
witnesses for raw field values, explicit nulls, timestamps and lifecycle transitions; dynamic/nonstandard facts
are retained losslessly. Browser projection uses a separate baseline table plus accepted suffix and pending
overlay. Fresh/behind devices can install a baseline atomically; historical comparisons or directives that
reach into the baseline recover original history on demand. Existing HTTP event readers remain compatible
through transparent archive hydration, and old socket cursors recover through HTTP rather than receiving
payload placeholders. The SDK's server checkpoint reader lets Stash seed a cold media index from the same base.

`MAINTENANCE_DAILY_WRITES` defaults to `10000` per job (bounded to 128–100000), and
`MAINTENANCE_DAILY_READS` defaults to `1000000` (bounded to 10000–1000000000). Jobs pause at either budget. Budgets use consumed SQL cursor
counts and can overrun by one bounded step. Structured step logs include SQL rows, R2 operations/bytes, elapsed
time and replay counts, without payloads or credentials. Resume with the same ID on a later UTC quota day;
other applications consume account quota too. The browser
can be closed safely and the operation resumed from the panel. No automatic snapshots or archive expiry run.
Deleting a whole log uses bounded background cleanup of that log's private archive objects, after normal
fork/deletion checks. Individual archived-history deletion is a separate future feature.

Use the full logical export or identity-preserving application transfer for backup/moves: they expand archived
payloads into the existing portable format. A SQLite-only export returns `409 archive_bundle_required` when
external checkpoint/archive objects are required, avoiding a misleading incomplete backup. Rollback after
compaction needs a compatible reader or a full logical restore first.

The first format bounds a single entity's replay witnesses to 8 MB and stores page descriptors in SQLite.
Exceeding a snapshot work/metadata bound fails the job while source history stays readable. Measure maintenance
work and storage on representative data; retained identity metadata still grows, and physical SQLite file size
need not shrink immediately when payload space becomes reusable.
