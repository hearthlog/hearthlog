# Ledger service design

Ledger is the durable write-side service for the offline-first Hearthlog application.
Clients keep local read models, submit domain events when online, replay
missing events after reconnecting, and receive ordered realtime events through
gateway-authenticated WebSockets.

## Runtime boundary

The deployed runtime is a TypeScript Cloudflare Worker:

- Elysia owns stateless HTTP routing and validation through the experimental
  `CloudflareAdapter`.
- Schemas in `src/schemas.ts` define HTTP request DTOs and registered response
  models.
- Route-scoped Elysia resolvers authenticate administrator and app routes and
  inject verified claims.
- Durable Object RPC carries plain structured-clone payloads and a
  discriminated `RpcResult` for expected domain failures.
- `LedgerApp.fetch()` is reserved for the exact WebSocket upgrade route.

Unknown fields and non-canonical query names are rejected. `afterVersion` and
`limit` accept non-negative or positive safe integers as appropriate. Page
sizes above 512 are clamped to 512.

Invalid input returns an explicit `LedgerError`, usually `400
validation_error`. Every other exception is a server fault and returns `500`,
so clients retry it instead of discarding a change.

## Durable Object topology

`AppRegistry` is addressed deterministically as `registry-v1`. It owns
application names, provisioning state, and credential lifecycle metadata. It
calls the target `LedgerApp` through its namespace binding; namespace access is
the internal capability boundary.

Each application UUID addresses one `LedgerApp`. That object owns the
application metadata, logs, events, entity claims, idempotency records, and
active hibernating WebSockets. This makes an application the coordination atom
while avoiding a global event-write bottleneck.

Both classes extend `DurableObject<Env>`, use generated Wrangler environment
types, and initialize ordered SQLite migrations inside
`blockConcurrencyWhile`.

## Authentication

The operator endpoints use `ADMIN_TOKEN`, compared in constant time after both
values are hashed to a fixed length.

Creating or rotating an application issues an HMAC-signed app token containing
the application UUID, principal UUID, generation, and signing-key ID. Every app
operation verifies the signature at the HTTP boundary and checks the claims
against `app_metadata` inside the application object. Rotation and revocation
therefore invalidate old tokens without a distributed token list.

The production browser never receives the long-lived app token. It calls the
same-origin `/api/ledger` gateway, whose Worker injects
`LEDGER_AUTH_TOKEN` and forwards through a service binding. Cloudflare Access
remains in front of the public deployment.

## Append and replay

An append request contains a UUID `requestId` and 1 to 512 events. Ledger:

1. validates event envelopes, including unique event IDs within the request
   and timestamps that a JavaScript `Date` can represent;
2. hashes a canonical representation of the log ID and event content;
3. checks any existing idempotency record;
4. rejects an action or event ID the log already accepted
   (`409 action_already_accepted` or `409 event_already_accepted`) and
   validates each entity's version chain;
5. assigns contiguous log and entity versions and rejects a response too large
   for one SQLite row (`400 request_too_large`);
6. inserts events and updates entity claims, Gallery photo references, and the log head;
7. persists the successful response for exact replay.

Steps 3 through 7 run in one synchronous SQLite transaction. A matching retry
returns the stored response after runtime validation. A different request body
under the same request ID returns `409 idempotency_mismatch`.

Realtime delivery runs after the transaction commits and is best effort. A
delivery failure is logged and never changes the append response; sockets
recover through HTTP replay.

HTTP replay is ordered and authoritative. `GET /logs/{logId}/events` pages by
global log version.

File originals (today Gallery's photos) are immutable app-scoped objects outside Ledger. An entity
whose definition declares a `fileReference` names its file version in a payload key (generated into
`FILE_REFERENCES`); a valid add, or an update that names a new version, grants only its own id and
file version to the current log. The reference is copied into a fork only when the event is
within the accepted fork prefix. The private file gateway checks the exact
reference through `GET /logs/{logId}/gallery-photos/{photoId}/files/{fileVersionId}/reference`
before accessing R2; an application or log check alone is insufficient.

## Realtime delivery

The browser opens the same-origin socket URL with its last applied log
version. The frontend Worker enforces same-origin access, injects its
server-side app token, and forwards the upgrade through a service binding.
Elysia verifies the token once, overwrites the internal claims header, and
routes the request to the application object. Durable Object namespace access
is the capability boundary for those internal claims.

The socket uses `ledger.v1` and is server-to-client only. Like HTTP replay, it
refuses a fork that is still being prepared (`409 fork_preparing`) and a client
whose replay version is too old for the log (`409 client_upgrade_required`). Catch-up emits
ordered `event` frames and then `ready`. A gap greater than 512 or a cursor
ahead of the log head produces `resync_required`; the client returns to HTTP
replay and reconnects from the new cursor. Attachments persist the cursor,
principal, and generation across hibernation.

## Recovery

The logical backup utility snapshots each log head, exports ordered NDJSON
pages, and records SHA-256 checksums in a versioned manifest. Restore validates
all files before provisioning a fresh application, replays and verifies every
page, rotates the bootstrap token, and revokes a partially restored target on
failure.

Deployment validation separates generated-type checks, Worker and Node
TypeScript checks, Durable Object contracts, bundle dry-run, startup profiling,
and browser-level HTTP/WebSocket/backup contracts.
