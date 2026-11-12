# Sync and history performance plan

Status: deliveries 0–3 released in core 0.13.7 and deployed to JST; deliveries 4–7 implemented on `perf/deliveries-4-7`,
not released or deployed. Budgets after delivery 1 were not measured (the machine was not fit for benchmarks).

Date: 2026-11-10.

This is the single plan for two tracks:

- **Track H, history as a read model.** Detailed in [history-read-model-plan.md](history-read-model-plan.md);
  summarised here only for sequencing.
- **Track S, sync and storage.** The architectural fixes from the review of `packages/runtime`, `packages/ledger`,
  and `packages/cloudflare`. Detailed below.

The review was a static read. Every expected gain in this document is reasoning about the code; the first step of
each track is to measure the current behaviour.

## Goal

Costs follow the work being done, not the size of the log:

- a save, an acknowledgement, or a realtime batch costs a small, fixed number of local transactions;
- catching up costs one transaction and a few statements per page;
- opening, scrolling, and inspecting history costs what is on screen (track H);
- switching to a log, or creating one, does not re-download or re-project what the device already holds;
- replay stays bounded without anyone pressing **Create snapshot**.

Invariants from `AGENTS.md` hold throughout: events and outbox bodies are never rewritten, retries stay idempotent,
rejected events stay in raw history, filtering and aggregation stay in SQL, Durable Object migrations stay
backward-compatible across a release window, and no deployed class, binding, or object identity is renamed.

## Track S: findings and fixes

### S1. Ingestion: one transaction and a few statements per page

Today (`event/handlers.ts` `handleIncomingStoredEvents`, `store/sync.svelte.ts` `download`): each 512-event page runs
separate transactions for covered events, new events, the version cache, and progress, plus two autocommit statements
for the sync log. Inserts go 40 rows at a time, each statement a round trip to the SQLite worker. Every downloaded
event also upserts a `local_batches` row keyed `server:<tenant>:<log>:<event>`, with a correlated subquery.

Changes:

1. One transaction per page: store events, mark tombstones, project affected records, update `entity_versions`, and
   record progress together. The directive pre-checks (`undoesReplayDirective`, `fillsDeferredReplay`,
   `schemaTombstoneIds`) stay before it; `rebuildReadModel` for directive pages stays after it.
2. Insert a page through one statement reading `json_each(?)`, for `raw_events` and for `entity_versions`. Tombstone
   ordering is kept by splitting the page at each tombstone, as today.
3. Stop creating `local_batches` rows for events that did not originate on this device. Only update the status of
   batches that already exist. `raw_events.local_batch_id` keeps its value (the column is `NOT NULL`, and
   `entity-sync-state` joins on it); a short constant per origin replaces the long per-event key for new rows.
4. `history/baseline.ts`: `installBaseline` and `loadArchivedHistory` stage each page with one `json_each` insert
   instead of one statement per event; `loadArchivedHistory` reads 512-event pages.
5. Sync log: prune every 100 inserts instead of on every insert, and write one entry per download, not per page.

Check first: the worker's SQLite build accepts a multi-megabyte bound text value and exposes `json_each` (the history
repository already relies on it).

### S2. Save and acknowledgement path

Today (`sync.svelte.ts` `executeOperation`, `store/outbox.ts`): one saved action runs about seven write transactions
and thirty statements around a single HTTP request; the acknowledgement re-projects records that were projected at
commit time; `getNextPendingBatch` lists every pending batch and probes each one on every loop iteration.

Changes:

1. One acknowledgement transaction: adopt accepted versions on the action's events, mark the batch and operation
   synced, update `entity_versions`, and record progress.
2. Skip re-projection on acknowledgement when the response is exactly the local batch and the local head was
   contiguous before it. Projection ordering puts pending events last, so the projected rows are already what the
   accepted events produce. Any other case (gap, different event set) takes today's path.
3. `getNextPendingBatch`: one query that returns the oldest pending batch without an open operation, using
   `idx_local_batches_scope_status`.
4. `updatePendingCount` and the retry wakeup run once per sync cycle, not once per operation and again at the end.

### S3. Draining a long queue: batched appends

Today: one HTTP request per action, in order. A device returning from a long offline period, or an import, sends
hundreds of sequential requests.

Changes (protocol addition, capability-gated like `action-metadata-v1`):

1. Ledger: `POST /logs/:logId/appends` takes an ordered list of ordinary append requests. `LedgerApp` runs them in
   order, each in its own transaction with its own request id, hash, and receipt, and stops at the first failure. The
   response lists per-request results. Socket delivery runs once at the end.
2. Advertise `append-batch-v1` in the session capabilities.
3. Runtime: when the capability is present and more than one operation is ready, send up to a byte and count bound
   (for example 64 operations or 1 MB) and apply the results in order through the same per-operation handling. A
   failure at position n leaves n+1 onward untouched and retryable, byte for byte.

Each request keeps its identity, so a lost batch response is retried safely one by one or as a batch.

### S4. Ledger read path

Today (`ledger-app.ts` `eventsAfter`, `storedEvent`, `http.ts`): the Durable Object parses every payload, RPC clones
the objects to the stateless Worker, Elysia validates the 512-event response against its schema, and the result is
stringified again. Every download cycle is preceded by `GET /maintenance`.

Changes:

1. `LedgerApp.listEventsText`: builds the response body by splicing stored payload text into the event envelope, and
   returns a string. The route returns it as the response without a response schema. Pages that contain archived
   rows keep the existing hydrated path.
2. `deliver` after an append sends the just-stored events to each socket whose cursor is exactly behind them,
   serialising each frame once; a socket further behind takes the existing catch-up read.
3. The runtime asks for maintenance state on the first sync of a page session, then at most hourly, and whenever a
   socket answers `resync_required` below the archived prefix; not before every download.

### S5. Storage growth

Today: `append_requests.result` stores a second full copy of every accepted event; on the device, synced
`outbox_operations` bodies, their items, and synced `local_batches` rows are never removed; `raw_events` carries nine
secondary indexes, two of them prefixes of others and four unscoped.

Changes:

1. Ledger: write `result` as an empty JSON object for new appends. Replays have used the version range since
   migration 9, and the transfer format already accepts a null result when the range is present. Gate: no deployed
   Ledger that predates migration 9 remains a rollback target. Existing rows are left as they are; clearing them is
   paid work and can ride a later maintenance job.
2. Device: delete `outbox_operations` in `synced` or `superseded` state older than 14 days with their items and
   their `local_batches` rows, in bounded batches after a sync cycle. Operations in any other state are never
   touched. Confirm `sync-issues.ts`, `local-recovery.ts`, and `pending-work-transfer.ts` read only unsynced work.
3. Device indexes: run `EXPLAIN QUERY PLAN` over the repository, sync, and projection queries on a seeded database,
   then drop what no plan uses. Candidates: `idx_raw_events_type` (prefix of `type_ts`), `idx_raw_events_entity_id`
   (prefix of `entity_version`), and the unscoped `timestamp`, `type_ts`, `entity_version`, `log_version`. This is a
   `SCHEMA_VERSION` bump shared with track H's new table.

### S6. Log switch and local fork seeding

Today (`shell/src/pages/layout/switch-log.ts`, `runtime/src/log-management.ts`): every switch calls
`loadStoredLogSnapshot`, which runs a full `rebuildReadModel`. That rebuild is what refreshes a log's projections
after a schema or module projection change, because `rebuildIfSchemaChanged` only rebuilds the active log. A new fork
is downloaded from version 0 although the device holds the same events under the source log.

Changes:

1. Record per log the schema version, projected table set, and module projection versions its projections were built
   with (new columns on `log_sync_state`). On switch, skip the rebuild when they match the current ones and
   `projected_head_version` equals `downloaded_head_version`; otherwise rebuild as today.
2. Seed a fork locally: when the source log is present through the fork point with no gap, copy its accepted
   `raw_events`, `entity_versions`, baseline rows, and (track H) index rows up to `source_version` under the new
   `log_id` in one transaction, set progress to `source_version`, and project. Then sync downloads only the suffix.
   A source that is not fully local falls back to the download.

### S7. Automatic snapshots and server readers

Today: snapshots are manual, so device replay, new-device bootstrap, and per-record projection grow with the log
until someone acts. The calendar feed reads the log from version 0 on every head change and gives up above 20 pages.

Changes:

1. Ledger: after an append, when the head is more than a threshold (default 5,000 events, configurable per
   deployment) past the last verified checkpoint, no job is active, and the application's policy allows it, the
   alarm starts a snapshot job. It uses the existing job, budgets, and pause rules. Compaction stays manual.
2. An application-level switch (default off) in the existing policy, set through `ensure:tenant`; turn it on per
   site after observing one manual snapshot on that site's data.
3. `cloudflare/src/calendar-feeds.ts`: build from `readLedgerCheckpoint` plus the suffix. Remove the 20-page limit
   for logs that have a checkpoint; keep it as a guard for logs that do not.

### S8. Copy-on-write forks on Ledger (design first)

Today (`ledger-app.ts` `forkLogValue`): a fork copies every event row, claim, and file reference of the prefix in one
transaction.

This touches every reader of `log_events` (event pages, sockets, receipts, claims, archive hydration, exports,
transfer, checksums, deletion rules) and deployed data. It is not scheduled for implementation here. The delivery is
a design note that answers: how a fork reads its parent's rows up to `source_version`; how claims resolve without a
copy; what deleting or compacting a parent means for its children; how transfer and logical backup stay complete;
and how existing copied forks keep working unchanged. S6 removes the device-side cost without it, so S8 is only
worth doing if measured fork cost on Ledger (rows written, wall time) justifies it.

## Baseline measurements (delivery 0)

Measured 2026-11-10 against core 0.13.6 (the current `main`) with the JST site's published modules, a local Ledger
(`hearthlog dev-ledger`), and headless Chromium through Playwright, each run a fresh device unless noted. Two seeded
Finance logs: 10,000 events and 50,000 events (35,150 actions: 150 imports of 100 records, 10,000 single adds, 25,000
single edits, 5,000 of them on 50 records), timestamps spread over two years. Not yet measured on a copy of real data.

The machine (Apple M2) carried heavy unrelated load during most runs (load average 5 to 27), so wall times vary 2–3×
between identical runs. Comparisons below were made in back-to-back runs, repeated; statement, transaction, and request
counts do not depend on load. The scripts are in this session's scratch directory, not in the repository.

### Device

| Operation | 10,000 events | 50,000 events |
| --- | --- | --- |
| Fresh device catch-up | 18 s on a quiet machine (550 events/s); pages slow from 90 ms to 1.2 s | Did not finish: 22,000 events after 8.7 min, then about 70 s per 512-event page (about 7 events/s) |
| Same, 256 MB page cache (diagnostic) | 18 s | Linear, about 12 s per page under load; 30,700 events after 8 min |
| Same, journal in memory and 256 MB cache (diagnostic, unsafe) | 6.2 s | 110 s; pages still slow from 0.2 s to 1.3 s |
| History: first page of 60 | 0.85–0.95 s | Fails: the query runs 133 s in the SQLite worker; the panel gives up at 15 s |
| History: one action, latest, newest | 0.35–0.55 s each | (same base query as above) |
| History: map points | 1.2 s (3,000 rows) | — |
| History: jump to version 1,500 | 1.0 s, 6,996 rows returned to the list | — |
| History: open an action | 0.3 s at version 1,540, 1.0–1.2 s at version 10,000; 287 statements | — |
| History: search | Fails (over 15 s) | — |
| Save one single-record action | — | Commit 0.4 s (1 transaction, 11 statements); acknowledgement 7.7 s (15 write transactions, 101 statements, 1 append request) |
| Save offline | — | 1.8 s per save |
| Drain 50 queued actions | — | 195 s (3.9 s each), 50 append requests, about 13 write transactions and 66 statements per action |
| Switch back to a log whose projections are current | — | 36 s, of which `rebuildReadModel` 27 s |
| Catch up the 10k log on a device that already holds the 50k log | 253 s (against 18 s on an empty device) | — |
| Local database size | 25 MB | 122 MB; one `local_batches` row per downloaded event (50,116) |

SQLite runs with sqlocal's `opfs` VFS and its defaults: 16 MB page cache (`cache_size = -16384`), 8 KB pages, rollback
journal (`journal_mode = delete`), `synchronous = full`. The database has no `sqlite_stat1` statistics.

### Ledger (local Worker)

| Operation | Result |
| --- | --- |
| One append, single event | 2.2–3.6 ms median on a quiet machine, flat from 1,000 to 50,000 events |
| One append, 100 events | 16 ms median |
| One 512-event page read | 19–31 ms median, 211 KB |
| `GET /maintenance` | 4–16 ms |
| Fork at the head of the 50,000-event log | 1.2–2.9 s in one transaction, which blocks every other request to the application |

### What the baseline changes

Six findings are larger than anything the review predicted, and four of them have small fixes:

1. **Catch-up is quadratic because of one statement.** In `storeIncomingBatch`, the `INSERT INTO local_batches … SELECT
   DISTINCT … FROM raw_events accepted WHERE … accepted.id IN (…)` is planned as a walk over the whole log through
   `idx_raw_events_batch`, because that index can serve the `DISTINCT`. It accounts for 49 of 81 seconds of SQL time
   in the CPU-bound 50k catch-up. Reproduced in native SQLite: 6 ms per 40-row chunk at 10,000 events, 29 ms at
   40,000; with the primary key forced (`INDEXED BY sqlite_autoindex_raw_events_1`) it is 0.7–1.0 ms at both sizes.
   The query is unchanged since the initial commit. S1.3 removes it for server events; a one-line plan fix removes it
   for local ones too.
2. **Past about 50 MB of database, the 16 MB page cache makes catch-up collapse.** Ingest falls from about 600 to
   about 7 events/s. Separately, every distinct page a transaction touches is first copied to the rollback journal
   through the OPFS proxy; with the journal in memory (unsafe, diagnostic only) the 10k catch-up is 3× faster.
   `synchronous = off` changes nothing. Randomly keyed indexes (event id, entity id, batch id, projection primary
   keys) make each page touch many distinct pages; removing the six redundant `raw_events` indexes saves 12%.
3. **Two queries scan the whole log on every save and every sync cycle.** `refreshEntitySyncState` (an `OR` across
   `sync_state` and a joined outbox status) takes about 1 s per call on the 50k log and runs after every save and
   several times per cycle. The replay-directive check (`type IN ('WORKSPACE_RESTORED', 'EVENTS_EXCISED')` with
   `projection_state`) is planned over the scope index instead of the type index without statistics: 760 ms per call,
   100 calls while draining 50 actions. Together they are most of the 7.7 s acknowledgement and the 3.9 s per drained
   action.
4. **History does not work at 50,000 events** (133 s for the first page) and search fails already at 10,000. This
   confirms track H; nothing smaller fixes it.
5. **Switching back to a log costs 27 s of rebuild** on the 50k log, confirming S6.1.
6. **Several logs in one database slow each other down**: catching up 10,000 events took 14× longer on a device that
   already held 50,000 events of another log, from cache pressure and the shared indexes.

The Ledger side is healthy at this size except for forks, which block the application for seconds; S3, S4, and S8
stay where they are, and S4 drops in priority. Also observed: every `withTiming` entry rewrites up to 250 entries to
`localStorage` and logs to the console, a small constant main-thread cost on every measured operation.

### Delivery 1 results

Measured 2026-11-10 with the same harness, seeded logs, and machine (load average 4 to 17), the fixes applied to the
published 0.13.6 runtime in the scratch site. The 50k device numbers come from a copy of the same primed profile, so
the first start also built the new index and statistics on an existing 50k database.

| Operation | Baseline | Delivery 1 |
| --- | --- | --- |
| Fresh device catch-up, 50,000 events | over an hour (22,000 events after 8.7 min) | 11 min, steady throughout |
| Fresh device catch-up, 10,000 events | 18 s | 18 s (journal writes dominate at this size) |
| Save: commit / acknowledgement, 50k log | 0.41 s / 7.7 s | 0.04 s / 0.8 s |
| Save offline, 50k log | 1.8 s each | 0.14 s each |
| Drain 50 queued actions, 50k log | 195 s | under 30 s; still one request and about 13 write transactions per action |
| Switch back to the 50k log | 36 s (27 s rebuild) | 6.8 s (5.3 s rebuild) |
| Catch up 10,000 events on a device holding the 50k log | 253 s | 37 s |
| History on the 50k log: first page / one action / open a recent action | fails (133 s) | 7–8 s / 2.4 s / 5.5 s; search still fails |

Statistics and the larger cache sped up queries delivery 1 did not touch, including module page refreshes and the
history base query. The page cache is 64 MB (`LOCAL_PAGE_CACHE_KIB`); its memory use on a phone has not been measured.

## Deliveries

Ordered so that each release is independently useful and reversible. H numbers refer to the history plan. Delivery 1
was added after the baseline: small fixes with the largest measured effect, ahead of the larger work.

| # | Scope | Where | Gate before the next |
| --- | --- | --- | --- |
| 0 | Baseline measurements on a seeded 50,000-event log and on a copy of real data; record them in this document. | Runtime, local Ledger | Done on seeded logs (above); a copy of real data is still to measure. |
| 1 | Quick fixes from the baseline: the `local_batches` plan (finding 1); `refreshEntitySyncState` and the replay-directive check on indexed plans, run once per cycle (finding 3); a larger page cache set in sqlocal's `onInit`, size chosen by measuring on a phone; `PRAGMA optimize` after a large ingest. | Runtime | Met on seeded data (results above): 50k catch-up completes at a steady rate; acknowledgement 0.8 s. Phone memory with the 64 MB cache still to check. |
| 1b | H1 (action index, reads on it) and H2 (targeted diff, no implicit archive load). | Runtime, shell | Implemented 2026-11-11 (`68aadd0`); equivalence tests pass. Measured once on the 50k log: a page in 6–7 ms, lookups 1–2 ms; first index build 37 s before it moved to the background, not re-measured. |
| 2 | S1 (ingestion) and S2 (save path). | Runtime | Implemented 2026-11-11 (`2bbdc56`); convergence suite passes with a new acknowledgement case. Budgets not measured. |
| 3 | S5.2, S5.3 (device pruning and indexes) and S6 (switch and fork seeding). | Runtime, shell | Implemented 2026-11-11 (`0177807`); a seeded fork equals the download row for row in tests. Budgets not measured. |
| 4 | S4 (read path) and S5.1 (receipt copy). | Ledger, then runtime for S4.3 | Implemented 2026-11-12 (`99d235f`): text pages equal object pages in the contract test; receipts store `{}` and replay. A caught-up device checks maintenance at most hourly. |
| 5 | S3 (batched appends). | Ledger first, runtime after the capability is live | Implemented 2026-11-12 (`2cc86fd`): `POST /appends` (≤ 64 requests, own receipts, stops at the first failure, replays); runtime drains ≤ 32 saves per request behind `append-batch-v1`. Ledger must deploy before the runtime uses it. |
| 6 | H3 (view mockups), then H4 (the approved view). | Shell | H4 implemented 2026-11-12 (`bb0ccda`) without the mockup round and without a browser run: cursor pages, bursts, month/day folds, bucketed map, delta refresh. Not virtualised on `EndlessList`. Needs a look in the app before release. |
| 7 | S7 (automatic snapshots, calendar feed). | Ledger, cloudflare, tooling | Implemented 2026-11-12 (`b3a0c8f`): policy `autoSnapshots` (off), `AUTO_SNAPSHOT_EVENTS` 5000; calendar feed folds checkpoint plus suffix. Switch stays off everywhere. |
| 8 | S8 design note; H5 (record history, archived action listing) if wanted. | Docs; Ledger, runtime | Separate go-ahead for each. |

Release order follows the existing rule: Ledger and gateway changes deploy before the runtime that uses them, and a
runtime that meets an older Ledger must behave as it does today (capability checks for S3; S4.3 and S7 need no client
support). Deliveries 1 to 3 are one or more core releases with no server change. Nothing here authorises a release, a
deployment, a compaction, or turning on automatic snapshots.

## Budgets

Targets to confirm or revise after delivery 0, not results. Headless, seeded log of about 50,000 events, measured with
the existing `withTiming` categories and Ledger step logs.

| Operation | Today (2026-11-10) | Target |
| --- | --- | --- |
| Ingest one 512-event page (store, project, progress) | 3 transactions, about 60 statements; 90 ms growing to 1.2 s at 10k, about 70 s at 22k | 1 transaction, under 10 statements, under 150 ms |
| Catch up 50,000 events from empty without a snapshot | over an hour (projected; 22,000 events in 8.7 min) | under 20 s |
| Save one single-record action, commit to acknowledged, excluding network | 16 write transactions, 7.7 s at 50k | at most 3 write transactions |
| Drain 500 queued actions | 500 requests, about 3.9 s per action at 50k | under 15 requests |
| Switch to a log whose projections are current | 36 s at 50k (27 s rebuild) | no rebuild; under 300 ms before views refresh |
| Open a fork of a fully local log | full download of the prefix | no event download for the prefix |
| Ledger time for one 512-event page | 19–31 ms | at least halved against delivery 0 |
| History: first page | 0.9 s at 10k; fails at 50k (133 s) | under 100 ms of SQL |
| History: open an action | 0.3–1.2 s at 10k, growing with version | under 150 ms |

If a change does not move its row clearly, drop the change instead of keeping the complexity.

## Verification

Tests stay few and protect data, access, and sync (`AGENTS.md`):

- `store/sync-convergence.test.ts` (run with `HEARTHLOG_INTEGRATION=1`) is the main guard for S1, S2, S3, and S6: it
  must pass unchanged, with added cases for a page split by a tombstone, an acknowledgement after an intervening
  remote event, a batch append that fails in the middle, a lost batch response, and a seeded fork.
- `event/rebuild-atomic.test.ts` and `commands/commit-invariants.test.ts`: the single-transaction paths leave no
  partial state when a statement fails.
- `store/pending-work.test.ts`, `restore-outbox.test.ts`: pruning never removes unsynced work.
- `db/schema-migration.test.ts`: index removal and the new `log_sync_state` columns migrate from version 43.
- Ledger worker suite (`packages/ledger/vitest.config.ts`): text pages equal object pages, receipts replay with an
  empty `result`, batched appends keep per-request idempotency, automatic snapshots respect budgets and the policy
  switch.
- `cloudflare/src/calendar-feeds.test.ts`: checkpoint plus suffix equals the full fold.

Commands: `pnpm -C dev check:ts`, `pnpm -C dev test:unit --run`, `pnpm -C dev ledger:check`,
`pnpm -C dev ledger:test`, `pnpm -C dev frontend:worker:typecheck`, `pnpm -C dev build`, `pnpm test`, and
`pnpm test:integration` before a release.

## Risks and open decisions

- **S2.2, skipping re-projection.** It rests on pending events already being projected identically. If any module
  projects differently from accepted versions, keep the re-projection; the equivalence case in the convergence suite
  decides.
- **S3 is a protocol change.** It adds surface to Ledger for a case (long queues) that may be rare outside imports.
  Delivery 0 should count how often more than a few operations queue on real devices before building it.
- **S5.1 and rollback.** An empty `result` cannot be replayed by a Ledger older than migration 9. Record the oldest
  deployable Ledger version before shipping it.
- **S5.2 retention.** Fourteen days is a guess; a device offline longer than that keeps its unsynced work regardless,
  but loses the bodies of already-synced requests, which only diagnostics read.
- **S6.2 trust.** A seeded fork trusts the local copy of the source. The copy is only taken when progress is
  contiguous through the fork point, and Ledger's checksums endpoint can verify it in tests.
- **S7 cost.** Automatic snapshots spend Durable Object and R2 budget without a person asking. The policy switch and
  the existing daily budgets bound it; the threshold needs real numbers.
- **Decisions carried from the history plan:** frozen labels, saved values for archived actions, and the burst rule.
