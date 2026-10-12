# Performance Review

Date: March 11, 2026

Scope:
- Static code review of the SvelteKit application
- Production build review via `pnpm build`
- Focus on startup cost, rendering behavior, data access, sync/event flow, and offline delivery

This is a code-and-build review, not a Lighthouse or browser trace report. Findings below are based on observed implementation details and production bundle output.

## Executive Summary

Overall, the app has a strong architectural foundation for an offline-first product:
- Local SQLite/OPFS keeps reads on-device
- Event sourcing and outbox sync are well-structured
- The database layer already includes several helpful indexes
- The codebase shows awareness of past N+1 issues and includes timing instrumentation

The biggest performance risks are not in the database core itself. They are mainly in:
- cold-start/install cost
- broad UI invalidation after sync events
- client-side processing on large entity lists
- eager chart/vendor loading for routes that use Highcharts

## Overall Assessment

- Startup and install performance: Fair
- Ongoing sync performance: Good, with avoidable UI refresh cost
- Data access and local DB design: Good
- Large-list rendering: Fair
- Bundle strategy for heavy routes: Fair
- Offline delivery: Strong, but currently expensive

## What Is Working Well

### 1. Good offline-first structure

The app is built around local-first data access and incremental synchronization rather than constant server fetches. That is the right baseline for responsiveness once the app is loaded.

### 2. Local database indexing is already present

The database setup includes indexes for common event, transaction, asset, invoice, and sync-log queries. That reduces the chance of the local SQLite layer becoming the first bottleneck.

### 3. Event handling is incremental

Incoming stored events are processed incrementally and projected by affected entity IDs rather than triggering full read-model rebuilds in the normal path. That is a strong design choice.

### 4. Sync flow already includes debouncing

The app debounces some invalidation and upload work, which helps avoid thrashing during bursts of local activity.

### 5. The codebase already contains performance hooks

`src/lib/utils/perf.ts` is a good foundation for turning this review into a measurable performance program.

## Highest-Impact Findings

### 1. Cold start and install cost are high

The app is fully client-rendered:
- `src/routes/+layout.ts` disables SSR

That is understandable for an offline-first app with browser-only storage, but it means first-use performance depends heavily on JavaScript, workers, and WASM arriving before the app becomes useful.

From the production build:
- SQLite WASM asset: about 856 KB raw, 392 KB gzip
- Highcharts vendor chunk: about 382.5 KB raw, 139.6 KB gzip
- BMI route client node: about 311.8 KB raw, 114.3 KB gzip
- Generated PWA precache: about 1910.78 KiB across 65 entries

Implication:
- First install is likely noticeably heavy on slower mobile networks
- Route-level code splitting exists, but the service worker precache policy reduces the benefit by pulling a large amount of route code offline up front

### 2. Sync currently refreshes more UI than necessary

The sync layer does good incremental data work, but the UI refresh strategy is still broad:
- download always calls view invalidation after sync
- WebSocket events trigger invalidation immediately for affected targets
- the app also polls the log list every 10 seconds while visible

This is likely to produce avoidable main-thread work, especially when:
- many events arrive in quick succession
- multiple tabs are open
- users are on larger entity pages

Impact:
- unnecessary route re-loads
- extra reactive recalculation
- more DOM work than the underlying data change really requires

### 3. Entity pages still do expensive client-side list work

The entity detail route is much better than the original N+1 design, but it still pulls up to 1000 rows with `SELECT *`, then performs:
- search across `Object.values(...)`
- client-side sorting
- client-side pagination

Reference options are also loaded per reference field, sequentially.

That means performance scales with row count and object width, not just what is visible on screen.

Impact:
- typing in search can become progressively slower as rows and columns grow
- sort cost rises with dataset size
- unnecessary payload is transferred from SQLite to JS for hidden columns and off-screen rows

### 4. Event processing still has some per-event overhead

The core event path is solid, but several hot paths still do work one event at a time:
- per-event `JSON.stringify` on insert
- per-event insert/upsert inside transactions
- per-event projection in a loop
- undo loads all events, sorts them again, builds a tombstone set, then searches for the latest live event

These choices are fine at small scale, but they will become noticeable as event history grows.

### 5. Chart routes pay a heavy vendor cost

The BMI, finance, and calc experiences use Highcharts or Highstock with static imports in their components.

That is a reasonable library choice, but it creates a meaningful bundle tax:
- users who rarely open chart-heavy screens still pay for them during offline precache
- chart updates rebuild or update full chart options reactively

The biggest visible cost today is likely not chart rendering itself, but loading and caching the chart stack.

## Medium-Impact Findings

### 1. Log list polling is eager

The root layout refreshes logs every 10 seconds while the document is visible. For a view that probably changes infrequently, this is more aggressive than necessary.

### 2. Finance queries are decent but can be tightened

The finance route is already doing useful parallelization. However:
- transaction filtering repeats the same due-date predicates twice
- some workloads would benefit from composite indexes rather than separate single-column indexes

This is not the largest current bottleneck, but it is easy cleanup.

### 3. PWA strategy favors offline completeness over installation speed

The current PWA setup broadly precaches static assets and route output. That is great for offline resilience, but it increases install and update cost.

For this app, that tradeoff should likely be made more selectively:
- app shell and SQLite worker assets: yes
- every infrequently used route chunk and chart dependency: probably not

## Recommended Priority Order

### P0: Reduce avoidable work

1. Narrow invalidation behavior
   - skip invalidation when a sync download returns zero new events
   - batch realtime-triggered invalidations across a short window
   - prefer store-level updates for small local changes over route invalidation

2. Make service-worker precache more selective
   - keep the app shell offline
   - move infrequently used route chunks to runtime caching
   - verify whether both WASM copies are necessary in the delivered client output

3. Lazy-load chart libraries
   - dynamically import Highcharts/Highstock only when chart components mount
   - optionally defer chart initialization until visible

### P1: Improve large-list scalability

4. Push entity list work into SQL
   - select only displayed columns
   - move search, sorting, and pagination into the database layer
   - keep the page result window small and explicit

5. Cache or parallelize reference option loading
   - avoid sequential reference lookups
   - memoize options per referenced entity type

6. Add list virtualization for very long tables
   - especially for entity and invoice-heavy views if item counts grow further

### P2: Optimize hot event paths

7. Replace full-history undo logic with a targeted query
   - fetch the latest non-tombstoned event directly in SQL

8. Consider batch insert strategies in `raw_events`
   - especially for sync downloads with many incoming events

9. Revisit projection granularity
   - if some entities become especially chatty, measure whether projector work can be reduced or cached

### P3: Add a measurable performance baseline

10. Turn current timing utilities into a simple dashboard
    - startup time
    - first sync duration
    - realtime event handling time
    - invalidation cost
    - entity page load time

11. Add a repeatable test dataset
    - large event log
    - 1000+ dynamic entities
    - multiple reference fields
    - high-volume sync replay

## Concrete Review Notes by Area

### Startup

Strengths:
- local-first architecture should feel fast after warm-up

Concerns:
- client-only rendering makes cold start JS-heavy
- SQLite worker/WASM plus chart vendor code creates a large install footprint
- precache policy currently emphasizes completeness over speed

### Sync and Event Flow

Strengths:
- incremental event processing
- outbox pattern
- version tracking and conflict handling

Concerns:
- invalidation is broader than the data changes require
- per-event processing overhead will scale with event volume

### Database Layer

Strengths:
- sensible indexing
- local queries rather than network dependency

Concerns:
- some hot flows still fetch more rows or columns than needed
- not all common filter combinations appear to have composite indexes

### Rendering

Strengths:
- Svelte is a good fit for a reactive local-first UI

Concerns:
- large entity screens still do too much client-side search/sort work
- heavy chart screens use large static dependencies
- repeated invalidation can re-trigger expensive derived work

## Suggested Next Metrics to Capture

If you want this review turned into a measured benchmark pass, I would capture:
- cold install time on a throttled mobile network
- app ready time after first load
- time to first usable entity page
- sync download time with 10, 100, and 1000 incoming events
- WebSocket burst handling for 20+ events
- typing latency in entity search with 1000 rows
- memory impact of chart-heavy routes

## Bottom Line

This app is architecturally stronger than a typical CRUD SPA from a performance perspective. The local database, event-sourcing model, and incremental sync design are all good foundations.

The main opportunity is to stop paying large UI and bundle costs around that solid core:
- reduce broad invalidation
- shrink first-install/offline download cost
- move big-list work out of the UI thread
- lazy-load chart/vendor dependencies

If those changes are made, the app should scale much more gracefully without needing a major architectural rewrite.
