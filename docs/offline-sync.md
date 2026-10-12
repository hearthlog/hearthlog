# Offline Sync Model

Hearthlog is the offline-first application and owns domain validation, local commands, and projections. Ledger is the authenticated multi-tenant event store and owns durable ordering, idempotency, entity-version concurrency, and event distribution.

## Offline app installation

After the first connected launch, the service worker precaches the complete
built app: its shell, route and lazy UI chunks, styles, fonts, icons, and the
SQLocal worker with one SQLite WASM copy. Any app page can then open without
having been visited online. The offline readiness indicator appears after the
worker activates and its essential cached files pass validation. Browser
storage eviction can still remove the bundle or local database.

Protected `/api/*` responses are network only. Events and read models remain
in local SQLite, while private PDFs, documents, and photos use their own
feature-specific device stores rather than the public app precache. Online
services such as AI extraction still need a connection.

## Identity and isolation

On first startup, Hearthlog calls authenticated `GET /session` and receives an `appId`
and `principalId`. The verified session is cached by compiled tenant identity,
Ledger origin, and a SHA-256 credential fingerprint (the bearer token, or the
Worker-managed identity for the same-origin gateway).

When the browser explicitly reports offline, an existing verified session in
that namespace opens local data immediately without session requests or retry
backoff. A first device or a different tenant, origin, or credential still needs
successful online verification. An online or unavailable connectivity hint keeps
the existing verification policy: gateway sessions are checked before opening,
while cached bearer-token sessions are rechecked in the background. Request
failures retain the existing cached-session fallback and Access reauthentication
behavior. The offline hint does not establish Ledger reachability.

Every durable local event, entity-version record, outbox operation, and sync head is scoped by `appId` and `logId`. Cached log metadata and the selected log are also keyed by Ledger origin and credential fingerprint. Switching logs changes the active scope and rebuilds projections from that scope. It does not delete the previous log's history.

## Startup synchronization

Bootstrap, sync, log selection, and log management share one configured Ledger
transport per tab.
Concurrent session and capability reads share the pending verification request;
later explicit session reads still verify online. Cached log metadata loads before
the guarded refresh loop's initial network read, without an extra immediate read.
New profiles retain their initial log-selection request.

After a successful coordinator HTTP catch-up, realtime can reuse that completion
for the same tenant/log scope and open from the committed contiguous cursor.
Ordered socket replay covers events accepted during the connection gap; oversized
gaps and a ready frame ahead of the local head still invoke HTTP recovery. A start
without a matching successful catch-up keeps its preconnect HTTP read. Lease and
log-generation guards remain active. See the
request comparison and recovery checks.

## Local schema readiness

Schema readiness checks and reconciliation run under `stor:schema`. Each check
uses one SQLite query to inspect the actual schema version, scoped primary keys,
approved projection tables, generated projection indexes, and the absence of
disabled static entity tables. A healthy current schema skips reconciliation
DDL and individual table queries; startup's two callers retain cheap inspections.
No persisted readiness cache can hide a replaced or damaged database.

Older versions retain the full migration path. Feature changes or missing
projection tables/indexes retain reconciliation and validation; invalid core
tables or primary keys still fail readiness. Raw history and runtime-defined
tables stay intact during feature reconciliation. The schema/feature-driven
read-model rebuild and dynamic registry loading retain their existing behavior.
See the startup comparison.

## Local write path

1. Validate a domain command in Hearthlog.
2. Persist the event batch with a local batch ID and stable event IDs.
3. Apply the events to the local projections immediately.
4. Before upload, persist an outbox operation containing the exact Ledger request body, request ID, and canonical request hash.
5. Retry that unchanged operation until Ledger confirms it or returns a permanent outcome.

For each entity in a batch, Hearthlog builds the Ledger 0.4 base-version chain in request order. A new entity uses omitted, `1`, `2`, and so on. An entity currently at version `N` uses `N`, `N+1`, and so on.

## Incoming event replay

Incoming pages keep raw history and affected projections in one transaction.
Raw-event upserts use at most 40 rows per statement; acknowledgement status is
derived in SQL from all members of the original local batch. Partial pages keep
that batch pending, and duplicate delivery retains payloads, local batch identity,
and existing action/author metadata when omitted by the repeated delivery.

Ordinary replay projects at most 100 affected records of one entity type at a time,
using the canonical projection SQL with an explicit tenant/log and entity set.
Other records stay untouched, and pending local edits remain in the projection.
Tombstones flush in delivery order; schema and restore/removal directives keep
their existing full-rebuild path. Version-cache upserts use at most 100 incoming
events and resolve repeated/older entity versions monotonically in SQLite. The
contiguous sync head advances only after ingestion and version updates succeed.

These are internal SQL batch sizes. Ledger's 512-event page limit and durable
append request bodies are unchanged. Per-entity diagnostics on the incoming path
are now recorded per projection group as `projectEntities:<type>`; local command
projection timings remain `projectEntity:<type>`.

## Refreshing the active page

HTTP catch-up, realtime delivery, and visible cross-tab changes share one serial
refresh queue. Realtime and cross-tab bursts schedule a run 150 ms after the first
change; later arrivals do not reset the deadline. A refresh already
running must finish first, and changes arriving during it receive a follow-up run.
HTTP catch-up and opening a stored log flush pending work immediately and wait
for route data and its visible consumer.

Sync retains every registered route dependency, including Calendar and Finance
dependencies on other domains. Each queued run updates pending/blocked counts,
invalidates routes, and emits the normal event-change signal for navigation
badges, private-file consumers, and native reminders. Its
`notifyEventsChanged({ routesInvalidated: true })` signal advances
`events.updatedAt` without advancing `events.refreshRequiredAt`, so Finance does
not start another route refresh for the same sync change. Even a failed route
refresh emits the general signal; the route error and sync error remain visible.

Local command and direct seed notifications keep the default signal behavior;
forms still await their existing `refreshPageData(...)` calls. This queue does
not deduplicate those calls or change event/outbox persistence. Hidden tabs retain
the existing deferred-refresh policy. See the
refresh comparison.

## Conflict and failure behavior

An `entity_conflict` means another device's events reached a record this batch edits. Hearthlog downloads them and compares, record by record, what the batch changed with what the other devices had accepted since the version the batch was based on (`packages/runtime/src/store/conflict-merge.ts`). An update carries only the fields it changed, so:

- **Different fields, or the same new value.** The batch merges: a new outbox operation with a new request ID sends the same events on top, and the old operation is marked superseded. This repeats up to five times while other devices keep writing; after that the operation needs attention.
- **The same field set to different values, a record another device deleted that this batch edits, or a deletion of a record another device edited.** Nothing is sent. The operation needs attention (`edit_conflict`) and Sync issues shows both values. **Keep mine** sends the same events again on top, which also restores a record the other device deleted. **Use theirs** saves the batch again as new events without the values that clashed (what did not clash is kept, and a record the other device deleted stays deleted); the original events stay in raw history as discarded. **Discard local** drops the whole batch.

`invalid_entity_version_chain`, `idempotency_mismatch`, `action_already_accepted`, and `event_already_accepted` are retained as needing attention.

No answer, a timeout, a 5xx, 408, 429, or `fork_preparing` is transient: the operation retries without limit, with jittered backoff capped at 60 seconds, and the status reads "Waiting to upload" rather than an error. Any other unexpected answer would repeat on every attempt, so the operation needs attention immediately.

HTTP 400 and 422 validation failures reject the local batch. Rejected events remain in raw history for diagnosis but are excluded from projections. Authentication and network failures do not discard local changes.

## Download and streaming

Hearthlog stores a downloaded head per tenant and log. Polling requests events after
that head. WebSocket delivery uses the same stored-event path; a detected gap
triggers an incremental download before the live event is applied. Replayed
events update existing local rows instead of creating duplicate projections or
outbox work.

Progress advances only across a contiguous prefix that was persisted and projected successfully. An append response is not evidence that intervening events were downloaded. For example, if device A downloaded through 10 and device B then accepted version 11, A's append of version 12 first stores/projects its own response and then downloads the missing 11. It must not set the download cursor directly to 12. The two-store regression is `packages/runtime/src/store/sync-convergence.test.ts`. Schema migration 19 repairs previously overstated cursors while retaining raw events and pending requests.

Pending edits are ordered by durable local sequence, including equal device timestamps. Once accepted, entity versions determine conflicting field values; late delivery of an older accepted event cannot lower the version cache. An incoming ordinary batch persists raw events and projects them in the same transaction. A local action is marked accepted only after all its members are present.

## Several tabs

Tabs of one browser profile share the SQLite file but keep their own session state, so they coordinate through Web Locks and a `BroadcastChannel` (`packages/runtime/src/store/tab-coordination.ts`). Without those APIs a tab behaves as if it were alone.

- **Live connection.** The visible tab that holds `stor:realtime:<tenant>:<log>` owns the WebSocket. Other tabs queue for the lock and hold no socket; hiding a tab releases the lock, so the next visible tab takes over, and a closed tab releases it automatically.
- **Sync cycles.** A cycle (download, then drain the outbox) runs under `stor:sync:<tenant>:<log>`, so tabs take turns instead of downloading and uploading at once. Any tab uploads the whole shared outbox, including edits another tab saved while offline.
- **Migrations.** The schema migration and the schema-version rebuild run under `stor:schema`; the tab that waits finds the work done.
- **Changes.** After a local commit, an ingestion, a rebuild, or an entity type change, a tab posts the kind of change and its log. Other tabs on that log refresh their pages and pending counts, and reload the registry of runtime-defined entities after a rebuild or type change. A hidden tab remembers the change and refreshes when it returns.
- **Local saves.** A commit that finds the database busy because another tab is writing waits briefly and tries again; its submission identity makes the repeat harmless.

Browsers do not share the E2E database (it lives in each page's session storage), so the hermetic journeys cannot cover two tabs. The lock and channel behavior is unit-tested in `tab-coordination.test.ts`.

## Action identity and restoration

An explicit submission ID (or the submitted event IDs) identifies a local retry. A retry must repeat the same event types and payloads; reusing the ID with different values is refused rather than silently returning the earlier save. Matching payload values do not merge distinct actions. When Ledger advertises `action-metadata-v1`, newly prepared requests carry a stable action ID; old durable request bodies remain unchanged. Grouping survives transport and backup, while legacy events remain singleton actions.

Selected-log restore is a special online conditional action. It persists its exact request before upload, requires the previewed accepted head, and stays invisible until accepted. A stale restore is rejected rather than automatically rebased. Ordinary edits queued before restore still upload normally. Restore selection, schema/definition materialization, and entity rows publish in one local transaction. Accepted appends remain retryable after local projection failure; they must not be reclassified as rejected domain commands.

Read [History and restore](history-and-restore.md) for the replay-version gate, full-log coverage, Undo policy, backup contract, and current replay cost. Read [Adding an entity](adding-an-entity.md) and [Adding a page](adding-a-page.md) for the reference extension path.
