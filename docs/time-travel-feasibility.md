# Feasibility Study: Read-Only Time Travel

Historical design study. App-wide time travel was retired in favor of [Log history and forking](history-and-restore.md).

## Executive summary

Read-only time travel is feasible in this application with moderate implementation risk. The current event-sourced architecture already keeps the necessary historical data in `raw_events`, scopes it by tenant and log, and rebuilds read models from event history. The safest implementation is to add a separate historical read path that projects a bounded subset of events without mutating the live read tables.

The recommended first version is a read-only snapshot mode:

- Users choose a point in the selected log history.
- The app renders entity state as it existed at that point.
- Writes, undo, sync upload, and destructive actions remain disabled while viewing the past.
- Returning to "Now" resumes the normal live read model.

This should not be implemented by rebuilding the live tables to an older point in time. The live tables are used by existing routes, sync invalidation, and write flows, so using them for time travel would create avoidable correctness and UX risk.

## Scope

### In scope

- View historical snapshots for the active tenant and log.
- Support static entity tables such as assets, transactions, invoices, invoice parties, and weight logs.
- Support dynamic entity types after their definition event exists at the chosen point in time.
- Show clear read-only UI state while time travel is active.
- Provide a stable way to select a historical point by log version, event, or date/time mapped to a log version.

### Out of scope

- Editing past state.
- Branching history from a past snapshot.
- Restoring history as a write operation.
- Replaying side effects.
- Cross-log historical comparisons.
- Server-side Ledger changes, unless better pagination or snapshot APIs are desired later.

## Current architecture fit

The existing design is a good foundation:

- `raw_events` is the source of truth and stores event type, payload, timestamp, tenant, log, entity ID, entity version, log version, local sequence, tombstone state, sync state, and projection state.
- Read models are derived from `raw_events` through `projection-builder.ts`.
- Full rebuild already exists in `rebuildReadModel()`.
- Projection SQL already filters to active tenant/log through `active_context`.
- Tombstoned and rejected events are excluded from normal projections.
- Sync state already distinguishes pending local events from synced Ledger events.

The main missing capability is a projection boundary. Current projection SQL always reads all effective events for the active context. Time travel needs the same projection logic with an additional "as of" filter.

## Recommended design

### Use a bounded historical projection path

Add projection support for an optional snapshot boundary:

```ts
type TimeTravelBoundary =
  | { kind: 'log_version'; version: number }
  | { kind: 'timestamp'; timestamp: number }
  | { kind: 'event'; eventId: string };
```

Internally, normalize user-facing choices to a deterministic log boundary:

- Prefer `log_version` for synced history.
- Convert a timestamp to the greatest synced `log_version` with `timestamp <= selectedTime`.
- Convert an event to that event's `log_version`.

For version 1, historical snapshots should include only synced events with `log_version <= boundary`. Pending local events can still appear in "Now", but they should not be mixed into historical Ledger snapshots unless a separate local-history mode is explicitly designed.

### Keep live projections untouched

Use one of these two implementation strategies:

1. Direct bounded queries from `raw_events`.
2. Temporary snapshot tables populated from bounded projections.

The recommended first implementation is temporary snapshot tables because it reuses the existing projection model closely and keeps route-level query code simpler.

Suggested flow:

1. User enters time travel mode and selects a boundary.
2. Create or clear temporary snapshot tables for each registered entity.
3. Run bulk projection SQL with the boundary filter into those temporary tables.
4. Historical routes/components query the snapshot tables through dedicated read helpers.
5. User exits time travel mode and the app drops or ignores snapshot tables.

This isolates historical reads from the live read model and prevents accidental mutation of current state.

### Add a projection boundary to the SQL builder

Extend `buildCommonCTEs()` in `projection-builder.ts` to accept an optional boundary and target scope. For a log-version snapshot, the effective CTE should add:

```sql
AND events.log_version IS NOT NULL
AND events.log_version <= :version
```

For timestamp selection, resolve the timestamp before projection:

```sql
SELECT MAX(log_version)
FROM raw_events
WHERE tenant_id = :tenantId
  AND log_id = :logId
  AND projection_state = 'effective'
  AND is_tombstoned = 0
  AND log_version IS NOT NULL
  AND timestamp <= :timestamp
```

Then use the resolved version for projection. This avoids ambiguous ordering when multiple events share a timestamp.

### Provide dedicated historical read helpers

Do not switch the global `db` object or `active_context`. Add read helpers that take a snapshot source:

```ts
type ReadSource = 'live' | { kind: 'snapshot'; snapshotId: string };
```

Examples:

- `getAssets(source?: ReadSource)`
- `getTransactions(year, month, source?: ReadSource)`
- `getInvoices(source?: ReadSource)`
- `getEntityTypes(source?: ReadSource)`

For the first version, the finance, entity, invoice, and BMI routes can read the active time-travel state and choose live or snapshot helpers. Write-capable components should receive an explicit `readonly` prop and hide or disable mutation controls.

## Data model considerations

### Ordering

Use `log_version` as the primary historical order for synced history. It is durable, server-assigned, and scoped to a log. Timestamps are useful for selection, but not reliable enough as the projection boundary because client clocks and duplicate timestamps can produce ambiguous states.

For "Now", the existing live read model can continue to include pending local events. For historical snapshots, exclude pending events by requiring `log_version IS NOT NULL`.

### Tombstones

Current projections exclude events with `is_tombstoned = 1`. This is fine for "current truth", but historical snapshots need a policy decision:

- Simple policy: tombstones are global corrections and apply to every snapshot.
- Temporal policy: a tombstone only affects snapshots at or after the tombstone event.

The temporal policy is more correct for time travel. It requires deriving effective events by excluding a target event only when the tombstone event itself is within the selected boundary. This is a change from the current denormalized `is_tombstoned` shortcut.

Recommended version 1: implement temporal tombstone handling in bounded projection SQL and keep `is_tombstoned` for live projections.

### Dynamic entity definitions

Dynamic entity types are replayed from meta-events today. Time travel should only expose dynamic types whose definition exists at the selected boundary and should use the field definition valid at that boundary.

This is feasible but increases complexity. A pragmatic first release can support static entities first, then add dynamic entity snapshots as a second phase.

### Rejected events

Rejected events should remain excluded by `projection_state = 'effective'`, matching current live behavior.

### Local-only events

Pending local events have no server `log_version`. They should be visible only in live "Now" mode. Including them in historical mode would require a second boundary model based on `local_sequence`, which is not necessary for a first read-only feature.

## User experience

Recommended UI behavior:

- Add a global "Time travel" control, likely in the navigation or developer/log tools first.
- Let users choose an event, a log version, or a date/time.
- Display a persistent read-only banner with the selected historical point.
- Disable add, edit, delete, undo, import, sync-write, and log-management actions while viewing history.
- Keep sync download active only if it does not mutate the viewed snapshot. The live database can continue syncing in the background, but the snapshot should remain pinned until the user changes it.
- Provide a single clear "Return to Now" action.

The first UI should start in the developer console or event log tools. After the model is proven, it can be promoted into normal navigation.

## Implementation plan

### Phase 1: Technical proof of concept

- Add a `TimeTravelBoundary` type and boundary resolver.
- Add bounded projection SQL support for static entities.
- Build temporary snapshot tables without touching live tables.
- Add tests that project assets and transactions at selected log versions.
- Verify tombstone behavior for before and after the tombstone event.

Estimated effort: 2-4 days.

### Phase 2: Read-only application mode

- Add time-travel state store.
- Add route-level source selection for finance, invoices, entities, and BMI.
- Add readonly props to write-capable components.
- Add UI banner and "Return to Now".
- Add Playwright coverage for entering/exiting time travel and blocked writes.

Estimated effort: 3-6 days.

### Phase 3: Dynamic entities and polish

- Replay dynamic entity definitions up to the boundary.
- Create matching snapshot tables for dynamic entities.
- Add event/date picker UX.
- Add performance caching for repeated snapshots.
- Add diagnostics for missing boundaries or partial local history.

Estimated effort: 3-7 days.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Live read model accidentally rebuilt to the past | High | Use separate snapshot tables/helpers only. |
| Timestamp-based snapshots are inconsistent | Medium | Normalize timestamps to log versions before projection. |
| Tombstones incorrectly alter past snapshots | Medium | Implement boundary-aware tombstone filtering. |
| Dynamic entity field definitions differ over time | Medium | Phase dynamic entities separately and replay meta-events to the boundary. |
| Route/component write controls remain visible | Medium | Add explicit read-only mode and tests for blocked writes. |
| Large logs make snapshot projection slow | Medium | Add indexes, cache recent snapshots, and start with developer-only UI. |
| Pending local events confuse historical state | Low | Exclude unsynced events from historical snapshots; show live state only in "Now". |

## Testing strategy

Unit tests:

- Boundary resolver maps event IDs and timestamps to expected log versions.
- Bounded projections include events at or before the boundary and exclude later events.
- Removed entities do not appear after removal, but do appear before removal.
- Tombstoned events appear before the tombstone boundary and disappear after it.
- Rejected events are excluded.

Integration tests:

- Time travel mode renders historical assets/transactions without altering live tables.
- Exiting time travel returns to current live state.
- Writes are disabled or blocked while a snapshot is active.
- Sync download during time travel does not move the selected snapshot.

Manual verification:

- Create an asset, update it, remove it, and inspect each boundary.
- Repeat with transactions to verify finance balances.
- Switch logs and confirm snapshot state is scoped to the active log.

## Feasibility verdict

Feasible and aligned with the existing architecture. The key is to treat time travel as a separate read source, not as a mutation of the live projection. A static-entity read-only version can be delivered with moderate effort. Full support for dynamic entities and polished UI is still feasible, but should be phased because historical schema reconstruction is the most complex part.
