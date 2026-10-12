# Ledger Durable Object database structure

Ledger stores data in two SQLite-backed Durable Object classes. Each object
has its own isolated SQLite database and its own
`_sql_schema_migrations` table. Application code applies pending migrations in
ascending numeric order during object initialization.

The deployed class names and object routing keys are durable data identities:

- `AppRegistry`, addressed as `registry-v1`
- `LedgerApp`, addressed by application UUID

Renaming a class, binding, or routing key would select different storage and is
therefore outside ordinary schema migration.

## AppRegistry

`AppRegistry` owns administrative application metadata. It never stores log
events.

### `applications`

| Column | Type | Constraints | Purpose |
| --- | --- | --- | --- |
| `id` | TEXT | primary key | Application UUID and `LedgerApp` routing key |
| `name` | TEXT | non-null, unique | Operator-visible application name |
| `created_at` | TEXT | non-null | ISO timestamp |
| `revoked_at` | TEXT | nullable | Revocation timestamp |
| `active_principal_id` | TEXT | non-null | UUID represented by the active token |
| `principal_generation` | INTEGER | non-null | Monotonic token generation |
| `active_token_created_at` | TEXT | nullable | Current token issue timestamp |
| `provisioning_state` | TEXT | non-null | `provisioning`, `active`, or `failed` |

`applications_created_idx` orders application listings by creation time. The
registry checks the unique `name` inside the insert transaction and translates
only that conflict to the public `409 app_name_conflict` error. A `failed` row
never issued a usable credential, so creating an app with the same name
replaces it.

Token rotation writes the new principal and generation before it awaits the
application object, so concurrent rotations receive distinct generations. A
rotation that fails afterwards leaves its generation reserved; the next
rotation still moves forward.

## LedgerApp

Every application has one `LedgerApp` database. This gives each tenant an
independent transaction and WebSocket coordination boundary.

### `app_metadata`

One row (`singleton = 1`) records the application UUID, name, active principal,
generation, creation/token timestamps, and optional revocation timestamp. All
app RPC calls validate signed claims against this row. Rotation only applies a
higher generation; a stale one returns `409 rotation_superseded`. `fence_mode` and `fence_destination` hold the write fence of a tenant move; `import_state`
is `importing` until an identity-preserving import finishes. `event_policy`
holds the application's event policy as JSON (see `src/event-validation.ts`); null
for an application that predates policies.

### `logs`

One row per event log:

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | TEXT primary key | Log UUID |
| `name` | TEXT | Display name |
| `version` | INTEGER | Current global log version |
| `created_at` | TEXT | ISO timestamp |
| `last_updated_at` | TEXT nullable | Last successful append |
| `source_log_id` | TEXT nullable | Parent log of a fork |
| `source_version` | INTEGER nullable | Parent version the fork copied through |
| `status` | TEXT | `ready`, or `preparing` until the fork is finalized |
| `hidden_at` | TEXT nullable | When the log was hidden from the log tree (migration 8) |

`logs_source_idx` finds a log's forks. A log with forks cannot be deleted.
Hiding changes only `hidden_at`; a hidden log keeps its events and forks and
stays readable and writable. Logical backups do not carry it, so a restored
application shows every log.

### `log_events`

The immutable event store. `(log_id, version)` is the primary key and
`(log_id, event_id)` is unique.

| Column | Type | Purpose |
| --- | --- | --- |
| `log_id` | TEXT | Parent log |
| `version` | INTEGER | Contiguous log version |
| `event_id` | TEXT | Event UUID |
| `event_type` | TEXT | Domain event type |
| `entity_id` | TEXT | Domain entity identifier |
| `entity_version` | INTEGER | Contiguous version within the entity |
| `event_timestamp` | TEXT | ISO timestamp |
| `payload` | TEXT | JSON object |
| `action_id` | TEXT nullable | Client action the event belongs to |
| `action_index` | INTEGER nullable | Position within the action |
| `action_size` | INTEGER nullable | Number of events in the action |
| `actor` | TEXT nullable | Identity the gateway verified for the appending request; null for older events |

`log_events_action_position` keeps each action position unique per log.
`log_events_replay_markers` is a partial index over `WORKSPACE_RESTORED` and
`EVENTS_EXCISED` events only. Reads, appends, and socket deliveries use it to
find the replay version a log requires without reading the whole log.

### `entity_claims`

One row per `(log_id, entity_id)` tracks the current entity version, the log
version where the entity was created, and creation/update timestamps. An
append checks all entity chains and writes events, claims, and the new log head
inside one synchronous SQLite transaction.

### `gallery_photo_references`

One row per accepted `(log_id, photo_id, file_version_id)` grants that log
access to an immutable file version outside Ledger (today Gallery's photo
originals). The table and its `photo_id` column keep their deployed names; `photo_id` holds the
id of whichever entity declares a `fileReference` in its definition. The row records the event's log
version, allowing a fork to inherit only references accepted through its fork
point. An accepted add of such an entity, or an update that names a new file
version, and its reference are inserted
in the same transaction. A preparing fork cannot use its inherited references
until file preparation is finalized. Removing a log removes its references;
removing a photo event does not immediately delete recoverable original bytes.

### `append_requests`

Stores `(request_id, log_id)`, a canonical request hash, the first and last log
version the request accepted, a serialized copy of the successful response, and
creation time. Exact retries rebuild the response from `log_events` through that
version range, so they report the original author. Rows written before the range
columns existed replay the validated stored copy. The copy keeps its
pre-authorship shape (no `actor`) so a rolled-back Worker can still replay it.
Reusing a request ID with different content returns
`409 idempotency_mismatch`. Because the response is one SQLite row, an append
whose accepted events serialize to more than 1,900,000 bytes is rejected with
`400 request_too_large` before anything is written.

### `log_fork_requests`

Maps a fork `request_id` to its source, fork point, expected source head, name,
and the created `fork_log_id`, so a retried fork returns the same log. Deleting
a fork removes its request row.

### `socket_sessions`

One row per accepted WebSocket records its connection ID, log, principal,
connection time, cursor and bounded handshake details (user agent, IP, country,
edge location). Closing or erroring sockets record their disconnect time, close
code, final cursor and last send. Clients close their stream while hidden, so
the administrator console lists these sessions beside live sockets. Each new
session prunes the table to the 50 most recent connections. A session that ends
without a close notification, for example during a deployment, keeps a null
disconnect time.

## Transaction boundaries

- Schema migrations run in `transactionSync`.
- Appends atomically update events, entity claims, the log head, and the
  idempotency response.
- Log deletion atomically removes idempotency rows, claims, events, and the
  log.

External work and asynchronous access-token signing occur outside SQLite
transactions. Cloudflare's Durable Object input/output gates provide the
surrounding single-object coordination.

Migration 2 removes the former `socket_tickets` table and the unused
`log_events_entity_idx`; deployed log and event data are unchanged. Migration 3
adds action metadata to `log_events`. Migration 4 adds fork lineage and status
to `logs` and creates `log_fork_requests`. Migration 5 adds
`log_events_replay_markers`; SQLite maintains it on every write, so earlier
code keeps working with it during a rollback. Migration 7 adds
`socket_sessions`; earlier code ignores it during a rollback. Migration 9 adds
the version range to `append_requests` and migration 10 adds `log_events.actor`;
both columns are nullable and earlier code ignores them during a rollback.
