# App Improvement Implementation Plan

Status: Phases 1–8 completed on 2026-07-12.

This plan follows the design/UX and CQRS/event-sourcing offline-first review. Reliability work comes first so later UX and domain additions build on a safe local database and a truthful synchronization model. No additional backend database or infrastructure is required.

## Phase 1 — Database bootstrap and migration safety

Goal: existing local databases always open successfully or fail before route loaders query an incompatible schema.

- Make SQLocal initialization compatible with every supported legacy schema.
- Move indexes that depend on migrated columns out of `onInit` and create them only after table migrations.
- Introduce one shared, cached local-store bootstrap that initializes SQLite, activates the selected tenant/log context, applies migrations, rebuilds projections when required, and validates the resulting schema.
- Ensure database-backed route loaders wait for the root bootstrap instead of racing layout `onMount` initialization.
- Keep migration execution idempotent and safe to retry after an interrupted upgrade.
- Add regression coverage for legacy unscoped projections, current scoped projections, and partially upgraded tables.

Acceptance criteria:

- A populated legacy database opens without data loss.
- Fresh and upgraded databases reach the same current schema.
- Bootstrap can be called repeatedly without changing data.
- No loader queries scoped columns before migration completes.
- The known `no such column: tenant_id` startup failure is no longer reproducible.

Implementation notes:

- Scoped calorie and entity-definition indexes are now created only after legacy table migration.
- Projection-table rebuilding preserves SQLite function defaults such as `datetime('now')`.
- Structural migrations validate all scoped primary keys before recording `PRAGMA user_version`.
- The root layout uses a shared per-tab bootstrap, and database-backed child loaders await their parent layout before querying projections.
- A Node SQLite fixture verifies preservation and idempotency when upgrading unscoped raw events, entity versions, calorie projections, and entity-type definitions.
- The previously failing existing browser profile now opens Today and Finance with its preserved data and no SQLite/bootstrap errors.
- Validation completed with zero Svelte diagnostics, 40 passing unit tests, a successful production build, and a build report.

## Phase 2 — Truthful readiness and synchronization state

Goal: clearly distinguish local database health, network reachability, offline work, pending uploads, blocked changes, and confirmed synchronization.

- Add explicit local-store states: `booting`, `ready`, `degraded`, and `failed`.
- Add explicit sync states: `offline`, `idle`, `syncing`, `pending`, `blocked`, `error`, and `synced`.
- Do not show “Synced” until the local store is ready and a sync attempt has succeeded for the active log.
- Replace fabricated zero-value fallbacks with calm unavailable states.
- Add recovery actions for retrying initialization, exporting local SQLite, and resetting safely from Ledger.

Implementation notes:

- Local bootstrap now exposes `booting`, `ready`, `degraded`, and `failed` state with schema and active-log context.
- Synchronization derives one explicit phase from network, active work, queue, conflict, error, and completed-sync signals.
- “Synced” is shown only after a successful sync cycle or processed Ledger stream event for the active log; a new or switched log starts at “Not synced yet”.
- The desktop shell, mobile status indicator, and Developer diagnostics use the same state presentation.
- Today shows a calm unavailable panel and retry action when its local Finance projections cannot be read instead of rendering fabricated zero values.
- Root bootstrap failures render a local-data recovery screen with a non-destructive retry. Existing SQLite export and Ledger reset controls remain in Developer; their destructive-flow hardening stays in Phase 6.
- Unit tests cover sync-state priority and ensure local readiness overrides remote status.
- Validation completed with zero Svelte diagnostics, 46 passing unit tests, a successful production build and build report, plus browser smoke coverage of Today and matching shell/Developer sync status.

## Phase 3 — Atomic local command execution

Goal: durable local state always agrees with the success or failure reported by the UI.

- Add a small application-layer command API above event construction.
- Centralize domain validation outside route components.
- Commit raw events, local batches, tombstone effects, and normal projections in one SQLite transaction.
- Handle dynamic-definition DDL through an explicit projection-pending/rebuild path when it cannot share that transaction.
- Signal synchronization only after the local transaction commits.
- Add submit-level idempotency for retries and double clicks.

Implementation notes:

- All interactive domain write surfaces now use one application-layer `executeLocalCommand` API instead of calling event persistence and sync signaling separately.
- Command validation checks event envelopes, duplicate IDs, required static-domain fields, finite required numbers, tombstones, meta events, and dynamic entity IDs before opening a transaction.
- Raw events, local batches, tombstone effects, and all affected normal projections commit in one SQLite transaction. A projection failure rolls the complete command back.
- Sync notification is a post-commit listener owned by the sync layer; routes can no longer signal an upload for a failed local write.
- Stable submission IDs deduplicate persisted retries, while an in-flight intent key coalesces concurrent equivalent submissions such as double clicks.
- Runtime entity-definition DDL is explicitly committed as `pending_ddl`, applied after the durable command, and retried during local-store bootstrap when it cannot complete immediately.
- Entity-type redefinition archives and replaces the definition as one durable command batch.
- Integration tests use an in-memory SQLite database and the production projection builder to verify successful materialization, full rollback, submission deduplication, and DDL deferral.
- Validation completed with zero Svelte diagnostics, 53 passing unit/integration tests, a successful production build and build report, plus browser startup and route-loading smoke coverage against the preserved OPFS profile.

## Phase 4 — Sync liveness and realtime recovery

Goal: transient failures and disconnected streams recover without reloads or additional edits.

- Add a sync coordinator for startup, local commits, online transitions, tab visibility, WebSocket health, and durable retry deadlines.
- Persist the next retry time and use exponential backoff with jitter.
- Protect per-log outbox draining across tabs with an atomic claim or Web Lock.
- Treat `navigator.onLine` as a hint rather than proof of Ledger reachability.
- Reconnect after a clean WebSocket close and resume from the persisted downloaded head.
- Serialize incoming stream processing and retain gap detection.
- Use sparse fallback downloads only while realtime delivery is unavailable or unhealthy.

Implementation notes:

- One coordinator now handles startup, local commits, online transitions, tab visibility, durable retry deadlines, realtime recovery, and manual log changes without losing triggers that arrive during an active sync.
- Retry attempts persist `next_retry_at` in the durable outbox using bounded exponential backoff with jitter; schema version 12 upgrades existing outbox tables before creating the retry index.
- Each tenant/log outbox drain is guarded by a non-blocking Web Lock so only one tab uploads it at a time. A tab that misses the lock schedules another coordinator pass.
- `navigator.onLine` is treated as a hint. Ledger reachability is recorded only after a successful request or WebSocket connection, and retryable upload failures preserve a truthful sync error.
- Normal coordinator passes skip catch-up downloads while realtime delivery is healthy. Startup, visibility resume, socket-health failures, and other unhealthy states use the persisted head for sparse catch-up.
- Clean WebSocket closes reconnect with backoff instead of remaining falsely open, and reconnects resume from the most recently processed version.
- Incoming WebSocket events pass through a serial queue, preserving arrival order and the existing version-gap download safeguard.
- Hidden tabs close their stream and suspend retry timers; becoming visible performs one catch-up pass and reopens the stream.
- Unit coverage verifies retry timing, absolute deadlines, Web Lock contention, serialized processing, clean-EOF reconnect/resume, and the schema-11-to-12 outbox migration.
- Validation completed with zero Svelte diagnostics, 58 passing unit/integration tests, a successful production build and build report, plus browser verification that the preserved OPFS profile upgraded and reached a connected, empty-queue sync state.

## Phase 5 — Conflict resolution UX and semantics

Goal: blocked optimistic state is visible and resolvable per operation.

- Expose affected entities, event types, error codes, retry history, and timestamps for each blocked batch.
- Add a Sync Issues drawer reachable from the shell.
- Support per-batch retry/rebase, reapply-local, discard-local, and inspect actions.
- Rebuild only affected entities when a local batch is discarded.
- Keep global outbox clearing as a Developer-only escape hatch.
- Mark affected domain rows as pending or blocked.
- Audit every resolution action.

Implementation notes:

- The shell sync status is now interactive on desktop and mobile and opens a focused Sync Issues drawer.
- Each blocked operation exposes its Ledger error, retry and rebase counts, timestamps, affected entity IDs, event types, and resolution history.
- Retry with latest, reapply as a new local batch, and discard-local actions are durable transactions and write an audit entry.
- Discard and reapply exclude the old optimistic events and reproject only their affected entities; global outbox clearing remains confined to Developer.
- Transactions, assets, and invoices display understated Pending or Blocked badges based on their effective local events.

## Phase 6 — Safe recovery tooling

Goal: recovery works even when ordinary database queries cannot run.

- Show pending and blocked counts before destructive recovery.
- Offer a SQLite download before reset.
- Stop synchronization and realtime delivery before deleting local storage.
- After deleting the database, hard reload without querying through the deleted driver.
- Reinitialize the current schema and restore remote events through the normal stored-event ingestion path.
- Add retry-migration before destructive reset.
- Test recovery while online, offline, unauthenticated, and with pending local changes.

Implementation notes:

- Developer and the root error screen show pending and blocked counts before destructive recovery and offer a dated SQLite download.
- Retry migration remains the primary action and uses the same idempotent bootstrap path as normal startup.
- Reset suspends new coordinator work, closes the WebSocket, waits for active synchronization to become idle, marks the recovery handoff, and only then deletes OPFS.
- No SQL is issued through a deleted worker. The app hard reloads immediately, recreates the current schema, and downloads the selected Ledger log through normal stored-event ingestion.
- Recovery sequencing is dependency-injected and covered by tests for successful deletion and deletion failure.

## Phase 7 — Verifiable offline readiness

Goal: make offline support an observable, tested capability.

- Define the offline app bundle: shell, every built route and lazy UI chunk, styles, fonts, icons, SQLite worker/runtime, and one canonical WASM asset.
- Keep private files in their feature-specific device stores.
- Expose an understated “Available offline” state after critical assets are confirmed cached.
- Precache every product route, including pages the device has not visited.
- Test online installation, full offline restart, offline writes, offline reload, and reconnect synchronization.

Implementation notes:

- The PWA build precaches all emitted app assets, including lazily loaded page and overlay code.
- SQLocal worker scripts and the worker-resolved SQLite WASM are precached; the duplicate main-bundle WASM remains runtime-cached instead of doubling the install payload.
- Workbox continues cache-first handling for immutable static assets and network-only handling for protected API responses.
- After service-worker installation, the shell verifies that the precache contains the app entry, SQLite worker, and canonical WASM before showing “Available offline”.
- The status stays understated while the complete bundle installs atomically.
- Unit tests cover complete asset selection and canonical WASM selection; the production browser test opens unvisited pages offline.

## Phase 8 — Design and UX refinements

Goal: improve information hierarchy while preserving the calm, finance-first, app-like experience.

- Compress Today’s mobile finance summary into a compact two-column layout.
- Collapse secondary Assets/Forecast detail behind a smaller summary.
- Remove the duplicate full-width mobile search action.
- Replace desktop Quick Jump, which duplicates the sidebar, with recent activity or meaningful cross-domain actions.
- Show unavailable Finance state instead of zero-value data.
- Make the shell sync control interactive for pending, blocked, or failed synchronization.
- Preserve the mobile bottom navigation, stable Finance mounting, mono shell identity, and `asOfVersion` history behavior.

Implementation notes:

- Today uses a compact two-column Finance pulse at mobile widths, with tighter number treatment that still expands cleanly on desktop.
- Assets and forecast are summarized in one quiet disclosure row; forecast detail is available without dominating the primary monthly figures.
- The duplicated full-width mobile search action is gone; mobile keeps the persistent shell search control.
- Desktop Quick Jump has been replaced by current-month transaction activity and a direct Finance continuation link.
- The existing unavailable Finance panel, interactive sync control, mobile bottom navigation, stable Finance route key, shell typography, and history URL behavior are preserved.

## Validation strategy

Unit coverage:

- Command validation and event generation.
- Retry scheduling and backoff.
- Conflict-resolution transitions.
- WebSocket close and frame parsing.

SQLite integration coverage:

- Schema upgrade fixtures.
- Projection rollback.
- Outbox claiming and crash recovery.
- Rebuild equivalence.

Browser coverage:

- First offline relaunch.
- Offline write and reconnect.
- Transient upload failure.
- WebSocket disconnect and gap recovery.
- Two-tab isolation.
- Repeated entity conflict.
- Migration failure and reset-from-Ledger recovery.
- Desktop and 390px mobile states.

Required validation baseline:

```bash
CI=true corepack pnpm check
CI=true corepack pnpm test:unit
CI=true corepack pnpm build
corepack pnpm build:report
```

## Delivery sequence

1. Migration bootstrap and upgrade tests.
2. Readiness state and truthful shell/error UX.
3. Atomic command/application layer.
4. Durable retry coordinator and realtime recovery.
5. Conflict-resolution UI and entity status.
6. Safe reset and remote rebuild.
7. Offline-ready service worker and offline browser tests.
8. Today/mobile information-density refinements.
