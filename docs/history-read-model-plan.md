# Log history as a read model

Status: deliveries 1 and 2 released in core 0.13.7. Delivery 4 (the view) implemented on `perf/deliveries-4-7` without
the mockup round (delivery 3), and not yet looked at in a browser; see section 4 for what differs from the direction.

Date: 2026-11-10.

## Goal

Log history stays fast and usable on a log with tens of thousands of events. Opening the panel, scrolling, jumping
from the map, and opening one action must cost work proportional to what is on screen, not to the size of the log.

This is track H of [sync-and-history-performance-plan.md](sync-and-history-performance-plan.md), which holds the
overall delivery order and the sync and storage track.

Out of scope here: the sync and ingestion changes (page transactions, outbox batching, Ledger read serialisation),
fork seeding, automatic snapshots, and any new restore or removal command. The panel stays a
side panel; no full-page history workspace and no History shortcut in the main navigation.

## What is slow today

| Area | Current behaviour | Cost |
| --- | --- | --- |
| `packages/runtime/src/db/history.ts` (`baseFor`) | Derives label, completeness, and sync error for every event of the log, ranks them, then keeps 60 rows. `list`, `get`, `latest`, `newest`, `points`, and `review` share it. | Whole log per call |
| `LogHistory.svelte` | Re-runs `list` with a larger `limit` on scroll and on every `events.updatedAt`; rows are plain DOM that only grows; a jump loads every row down to the target. | Whole log per page and per sync |
| `history/action-boundary.ts` | Counts an action's members by `action_id`, which has no local index. | Per event |
| `outbox_operation_items` | The sync-error lookup matches on `event_id`; the key is `(operation_id, ordinal)`. | Per event |
| `history/point-snapshot.ts` (`readActionChanges`) | Projects the whole workspace into an attached in-memory database at two versions and diffs them; re-runs on every sync while a row is open. | Whole log, twice, per open |
| `history/baseline.ts` (`loadArchivedHistory`) | Any inspection on a log with a baseline downloads the full archived prefix and removes the baseline; the next sync may install it again. | Whole archive per inspection |
| `LogPanel.svelte` | Loads up to 3,000 labelled points for the map through the same base query. | Whole log per open |

`history/history.ts` (list functions), `history/timeline.ts`, `history/action-detail.ts`, and `HistoryScrubber.svelte`
have no callers outside themselves. Confirm with a repository-wide search before removing them (delivery 1).

## Design

### 1. Action index

A core table, `history_actions`, one row per action per log. It is a projection of `raw_events`: it can always be
dropped and refilled, and it never becomes a source of truth.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `log_id`, `action_key` | Primary key. The key is the accepted `action_id`; for a pending local batch, its first event id (which becomes the action id on upload); for an event without action metadata, the event id. |
| `id` | The representative event id (the last member), so existing `historyAction` links keep working. |
| `version`, `first_version` | Last and first accepted log version; null while pending. |
| `local_sequence`, `timestamp` | Ordering for pending actions and the time shown. |
| `type`, `feature`, `actor` | Representative event type, owning feature, author. |
| `event_count`, `received_count` | Declared size and members present; equal means complete. |
| `entity_id`, `entity_count` | The single record touched, when there is one. |
| `label` | The name shown, frozen as of the action. |
| `state` | `pending`, `accepted`, `rejected`, or `excluded`; "needs attention" for pending rows is read from the outbox at query time (few rows). |
| `in_replay` | 0 when a restore or removal set the action aside. |
| `payload_local` | 0 when the events were replaced by a baseline and only the index row remains. |

Indexes: `(tenant_id, log_id, version DESC, local_sequence DESC)`, `(tenant_id, log_id, timestamp)`,
`(tenant_id, log_id, feature, version DESC)`, unique `(tenant_id, log_id, id)`. Supporting indexes on existing tables:
`raw_events (tenant_id, log_id, action_id)` and `outbox_operation_items (event_id)`.

**Maintenance.** One function, `indexActions(tx, context, eventIds)`, re-derives the rows of the actions those events
belong to in a single upsert, the same way `projectEntitySet` re-derives records. It is derived, not incremental, so
calling it twice is harmless. It is called inside the existing transaction at each place raw events change:

- `commands/local-commit.ts`: a local save.
- `event/handlers.ts` `storeIncomingBatch`: downloads, realtime, and upload acknowledgements.
- `store/outbox.ts` `rejectBatch` and `clearOutbox`: state changes.
- `history/legacy-replay.ts` `reconcileRestoredEvents`: `in_replay` for the scope, in one statement.
- `history/baseline.ts` `installBaseline`: keeps index rows and sets `payload_local = 0` for the replaced prefix;
  `loadArchivedHistory` sets it back.
- `event/handlers.ts` `deleteActiveLogData`: removes the scope's rows.

**Labels.** Computed at index time with the existing rule (the record's newest name at or before the action, else its
summary value, else its entity label), restricted to the affected events. A later rename does not rewrite older rows.
Within one downloaded page the name can lag a rename in the same page; the backfill and any rebuild fix it.

**Backfill.** `SCHEMA_VERSION` 44 creates the table and indexes. Each log is filled on first activation, in chunks of
about 2,000 events ordered by version, under the schema tab lock, with the cursor stored per scope so an interrupted
fill resumes. The panel reads only indexed rows and shows a one-line status while the fill runs.

**Reads.** `createHistoryRepository` keeps its method names and return shapes and moves to the table:

- `list`: keyset paging (`version < cursor ORDER BY version DESC LIMIT n`), with pending rows first. `total` becomes
  a `COUNT(*)` over the same indexed filter. Fork markers are merged in by version as today.
- `get`, `latest`, `newest`: single index lookups.
- `points`: unchanged contract in delivery 1; replaced by buckets in delivery 4.
- `review`: two indexed counts and one `GROUP BY feature`.
- `search`: `instr` over `label` and `type` in the table. Searching saved values stays available as an explicit
  option that scans `raw_events.payload` and maps hits back to actions.
- `savedValues`: reads the action's members through the new `action_id` index.

`last-change.svelte.ts` reads its label by action key instead of `list({ limit: 1, eventIds })`.

### 2. Targeted action diff

`readActionChanges` gets a fast path that compares only the records the action touched:

1. Read the action's members and their entity ids.
2. Take the full-snapshot path (today's code, unchanged) when a member is a restore, removal, undo, or
   `ENTITY_TYPE_*` event, or when `hasReplayDirectives(db, scope, version)` is true for the boundary.
3. Otherwise create only the touched entities' tables in the attached in-memory database and run
   `buildProjectionSQL` twice, with `boundary: { kind: 'log-version' }` at `previousVersion` and at `version`, an
   entity filter, and `projection_events` as the source so baseline witnesses are included.
4. Diff the two with the existing comparison SQL.

Restores and removals show a summary (target point, actions set aside) with the full comparison behind an explicit
control.

The detail effect in `LogHistory.svelte` stops re-running on `events.updatedAt` unless the open action is pending.

### 3. History with a baseline

- Actions above the baseline use the fast path; no archive download.
- Actions at or below it fetch only their own version range (`getEventPage` from `first_version - 1`, at most the
  action size) and show the saved values, labelled as such, without writing to `raw_events` and without removing the
  baseline. A full before/after for those stays behind the existing explicit **Load the archive** control.
- `withPointSnapshot` no longer calls `loadArchivedHistory` implicitly.
- A device that started from a snapshot has no index rows for the prefix. It shows "Earlier history is archived" with
  the explicit load, as today. Listing that prefix without payloads needs a Ledger endpoint that pages action
  summaries from its SQLite identity rows; that is delivery 5 and optional.

### 4. View

Design direction, to be confirmed with mockups before any of it is built:

- **Virtualised list** on `EndlessList`, paging by version cursor; a jump from the map or a link seeks to that
  version and loads a window around it.
- **Time groups.** Recent days list their actions. Older time folds into month rows, then day rows, each with a count
  and the sections involved, aggregated in SQL from the index.
- **Bursts.** Consecutive actions with the same feature, author, and kind within a short gap (an import, a bulk edit)
  show as one expandable row. A `run_id` column assigned at index time keeps this an indexed read.
- **Density map.** `LogMap` draws at most a few hundred time buckets from one `GROUP BY`; individual points appear
  only when the visible span holds few actions. Fork lines and the on-screen bracket stay.
- **Delta refresh.** New actions are prepended from `version > top`; the list is not reloaded on sync.
- **Record history** (optional): opened from a record, the same panel filtered to that record's actions through
  `idx_raw_events_scope_entity`.

As built (delivery 4): the list pages bursts by cursor (`timeline`, `members`, `countBelow` in `db/history.ts`);
bursts are consecutive accepted actions of the same type, section and author within two minutes (`run_start`,
index format 2); history folds into months once a log has more than 400 actions, below the newest 300 actions and
14 days; fork points inside folded history sit above their month; the map draws at most 400 points, else 240
slices. Not built: virtualisation on `EndlessList` (the folds and bursts bound what is on screen instead), and record
history.

## Deliveries

| # | Scope | Gate before the next |
| --- | --- | --- |
| 1 | Supporting indexes, `history_actions`, `indexActions` at every write site, backfill, repository reads on the table, cursor paging in `LogHistory` with the current look, removal of the unused scrubber layer. | Index equals the old query's result on every fixture; budgets below met on the seeded log. |
| 2 | Targeted diff, directive summaries, baseline behaviour without implicit archive loads, detail no longer re-run on sync. | Fast path and full path give identical changes on every fixture without directives; no baseline removed by inspection. |
| 3 | Mockups of the grouped list, bursts, and density map on a canvas. | Feedback on the mockups. |
| 4 | The approved view: virtualisation, groups, bursts, bucketed map, delta refresh. | Browser journey passes; scroll and jump stay within budget. |
| 5 | Optional: record history entry point; Ledger action-summary endpoint and prefix listing after a snapshot. | Separate go-ahead; the endpoint is a Ledger and gateway change with its own release order. |

Deliveries 1 and 2 change no visible design and can ship together in one core release. Nothing here authorises a
release or a deployment.

## Budgets

Targets to confirm or revise by measurement, not results. Measure headless on a seeded log of about 50,000 events
(`packages/runtime/src/utils/perf-dataset.ts`, existing `withTiming` categories), before and after each delivery:

| Operation | Target |
| --- | --- |
| Open the panel (first page and map data) | under 100 ms of SQL |
| Next page while scrolling | under 30 ms |
| Jump to an arbitrary action | under 50 ms |
| Open an action touching one record with up to 200 edits | under 150 ms |
| Added cost per saved action (index upsert) | under 5 ms |
| Backfill of 50,000 events | under 10 s total, never one blocking step over 250 ms |

Record the before numbers first; if the index does not beat the current query by a wide margin on this log, stop and
revisit the design.

## Verification

Tests stay few and protect data (`AGENTS.md`):

- `packages/runtime/src/db/history.test.ts`: the index matches a derivation from `raw_events` after local saves,
  downloads in several pages, acknowledgements, a rejected batch, a cleared outbox, a restore, a removal and its
  undo, a baseline install, and an archive load. Running `indexActions` twice changes nothing.
- A new test beside `point-snapshot.ts`: fast and full diff agree for added, edited, removed, and re-created records,
  explicit nulls, multi-record actions, and an action above a baseline.
- `packages/runtime/src/db/schema-migration.test.ts`: version 43 to 44 creates and backfills, and resumes after an
  interruption.
- Extend the existing history browser journey for paging, a jump, and opening an action; no new journey.

Commands: `pnpm -C dev check:ts`, `pnpm -C dev test:unit --run`, `pnpm -C dev build`, `pnpm test`, and
`pnpm test:integration` before a release because module consumers of the SDK build against the runtime.

## Risks and open decisions

- **Write sites.** A missed call leaves the index stale. The equivalence test covers the known sites; a developer
  page action that rebuilds the index for the active log is the recovery path.
- **Frozen labels.** History shows a record's name as of the action. Confirm this is wanted over always showing the
  current name.
- **Saved values for archived actions.** Showing values without a before/after is a visible reduction for old
  actions on a compacted log, in exchange for never downloading the archive implicitly.
- **Storage.** A few hundred bytes per action plus three indexes; a few megabytes at tens of thousands of actions.
  Measure with `db/local-statistics.ts`.
- **Search.** Label search is fast; value search remains a scan. Full-text indexing is not planned unless the scan
  proves too slow in measurement.
- **Burst rule.** The gap and the definition of "same kind" need the mockups and real logs (CLI imports) to settle.
