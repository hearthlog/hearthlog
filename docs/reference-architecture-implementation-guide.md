# Reference architecture: focused implementation guide

Status: historical implementation record from 2026-09-08. Its Undo, restore, and app-wide snapshot sections describe retired product behavior and refer to files removed in the Log fork cleanup. Use [Log history and forking](history-and-restore.md), [Adding a page](adding-a-page.md), and [Adding an entity](adding-an-entity.md) for current work. See [evidence](architecture-evidence.md) for the original verification record.

Read the [architecture plan](reference-architecture-plan.md) for goals and confirmed choices. Keep the working event sourcing, CQRS, synchronization, history, and tenant architecture. Implement in the existing directories. New abstractions must solve a demonstrated problem.

## 1. Establish the baseline without redesigning it

1. Inspect `git status --short`, `git diff`, and `git diff --cached`. Preserve unrelated changes. Use a `codex/` branch if needed; never reset the existing checkout to obtain a clean baseline.
2. Re-read the relevant implementation before each slice. The original review identified a cursor risk in `src/lib/store/sync.svelte.ts`; changes may have landed since that inspection.
3. Record existing APIs and their responsibilities in `docs/architecture-evidence.md`:

| Concern | Existing entry points |
| --- | --- |
| Entity definitions/generation | `packages/contracts/src/event/entity-definitions.ts`, `scripts/generate-entities.ts` |
| Local commands | `src/lib/commands/index.ts`, `local-commit.ts`, `validation.ts` |
| Delivery | `src/lib/store/outbox.ts`, `outbox-request.ts`, `sync.svelte.ts` |
| Projection | `src/lib/event/handlers.ts`, `projection-builder.ts`, `rebuild.ts` |
| Queries/pages | `src/lib/db/read-repositories.ts`, `src/lib/runtime/page-data.svelte.ts` |
| History | `src/lib/time-travel/history.ts`, `read-model.ts`, `coordinator.ts` |
| Tenants | `packages/contracts/src/features/registry.ts`, `packages/contracts/src/tenant/config.ts`, tenant generation/provision scripts |

4. Run the existing focused baseline in the validation section. Record failures separately from new failures.
5. Use synthetic/sanitized fixtures for accepted events, pending batches, uncertain outbox requests, tombstones, and dynamic entities. Do not copy family data into tests.
6. Record current schema versions and append limits before changing them. The earlier review found projection schema 18 and a 50-event client batch limit; these are inspection results, not values to hard-code into future migrations.

**Done when:** the current behavior and baseline results are recorded. No new architecture layer is required.

## 2. Reproduce and fix skipped synchronization versions

Primary files: `src/lib/store/sync.svelte.ts`, `src/lib/store/outbox.ts`, `src/lib/event/handlers.ts`, and existing sync tests. Add `src/lib/store/sync-convergence.test.ts` if a new test file is useful.

1. Reuse the SQLite/Kysely fixture pattern in `src/lib/commands/local-commit.test.ts`. Create two independent local stores with one controlled Ledger transport. Extract only the dependencies needed to test the real production path; do not build a general simulation framework first.
2. Reproduce this interleaving:
   - A has accepted versions 1–10 locally.
   - B appends event 11 for another entity.
   - A uploads its pending event, accepted as 12.
   - A receives only its append response, then catches up.
   - A must store and project event 11; acknowledging 12 must not cause it to be skipped.
3. Separate observed server head from contiguous downloaded progress. Record observations only where useful; no new SQL column is mandatory if the observation need not survive restart.
4. Advance downloaded progress only across verified persisted positions. `MAX(log_version)` or an upload's `newVersion` is not proof of a complete prefix.
5. Advance projected progress only after the corresponding projection work succeeds. Reconcile upload metadata through the existing incoming-event/projector mechanisms where practical; avoid two subtly different acceptance paths.
6. Acknowledge WebSocket progress from the safe downloaded prefix. Ensure duplicate notifications remain idempotent.

**Tests:** 10/11/12, duplicate response/notification, a delayed earlier event, and pending-to-accepted reordering. Assert raw IDs, progress, and entity values, not just a status label.

**Done when:** the regression fails before the fix and passes after it. Keep this a focused behavioral change, not a rewrite of `sync.svelte.ts`.

## 3. Repair existing cursor state safely

Primary files: `src/lib/db/index.ts`, `schema-migration.test.ts`, and the sync/bootstrap code selected by step 2.

1. Determine whether prior clients can have persisted an overstated cursor. If so, add a restart-safe one-time repair per tenant/log using the current migration mechanism.
2. Inspect accepted log positions from a trusted origin. Lower downloaded progress to the first missing position; do not trust the old cursor as the start of the scan.
3. Preserve accepted rows, pending events, local batches, original outbox requests, and request hashes. Fetch missing events through normal catch-up.
4. Rebuild or repair affected projections using existing rebuild mechanisms. Keep projected progress conservative until successful.
5. Mark repair complete durably. Restart before completion must be safe.
6. Verify the full log can be downloaded. If delivery is filtered or truncated, establish a verified checkpoint/skipped-position contract before treating absence as a gap. Disabled-domain events can be stored without being materialized.

**Tests:** versions 1–10 and 12 already stored, interruption during repair, offline startup with pending work, and unaffected second tenant/log.

**Done when:** existing affected clients recover without data resets. Skip a migration only with evidence that old persisted state cannot require repair.

## 4. Verify nearby invariants; fix only reproduced failures

Use existing tests and small additions. Each row is a hypothesis/contract to verify, not authorization for a broad subsystem replacement.

| Scenario | Inspect first | Change only if evidence requires it |
| --- | --- | --- |
| Equal-timestamp local edits | `event/projection-builder.ts`, local sequence assignment | Use durable local sequence instead of random-ID tie-breaking |
| Explicit null versus omitted field | Projection field extraction and supported field definitions | Distinguish field presence for nullable patches; preserve legacy meanings |
| Accepted acknowledgement changes ordering | `outbox.ts`, incoming handlers | Re-project affected entities when needed |
| Lost append response | Durable request persistence and retry | Preserve original request ID/body/hash until outcome resolves |
| Restart after raw persistence | Incoming transaction and projection progress | Atomic projection or explicit existing recovery work |
| A→B log switch during upload | `local-context.ts`, sync callers | Capture and pass scope at the problematic boundary |
| Two tabs upload together | `sync-coordinator.ts`, browser storage behavior | Fix demonstrated ownership issues; do not add a lease system preemptively |
| HTTP page splits a batch | Incoming batch acknowledgement | Require all batch events before marking the batch accepted |
| Same submission retried vs two identical actions | `commands/index.ts`, `local-commit.ts` | Stable submission IDs; return original persisted IDs on duplicate |
| History navigation encounters hidden events | `time-travel/history.ts` | Filter visibility before SQL limit/adjacency selection |

For projection fixtures, compare incremental application, full rebuild, and history at the same accepted boundary. For multi-tab behavior, use distinct browser contexts/stores as appropriate; an in-memory unit test does not establish browser locking behavior.

Keep later-server-accepted field updates as the default. Automatic rebase is not a defect merely because it can overwrite an earlier value: that behavior was selected by the owner. Verify patches preserve untouched fields and accepted history retains both values. Ask about remove/update/recreation only if a semantic change is necessary.

**Done when:** important invariants have evidence and reproduced defects have focused fixes. Passing tests can close a row without production changes.

## 5. Add one entity and custom page using today's architecture

Create an isolated local example/sandbox branch or test tenant for Books. Do not enable it for family tenants or deploy it. Decide whether the example remains as a fixture or a disabled reference domain after evaluating it.

Suggested data: book title, author, reading status, notes, and optional finished date. Use currently supported field semantics; document limitations instead of expanding the descriptor language in advance.

1. Add the entity through `ENTITY_DEFINITIONS` with stable event/table names.
2. Run `pnpm generate:entities`; record which outputs are already generated.
3. Use the existing `executeLocalCommand` path for create/update/remove. Record any payload construction that must be repeated manually.
4. Add scoped queries following an existing repository such as `src/lib/db/calendar.ts`; register through the current `read-repositories.ts` mechanism if needed.
5. Write a custom Svelte page and loader following `deferPage`, `queryDatabase`, contextual time, and `CommandOnly` conventions. Keep product UI hand-authored.
6. Register the feature/navigation and refresh dependencies using the current mechanisms.
7. Enable it in the local test tenant only.
8. Verify create/edit/remove offline, reload, subsequent synchronization, remote refresh, historical reading, blocked historical writes, and disabled-tenant access.

Create `docs/extension-exercise.md` with an exact inventory:

| Measure | Before improvement | After selected improvement |
| --- | --- | --- |
| Hand-edited domain/UI files | Record | Record |
| Hand-edited infrastructure/registration files | Record | Record |
| Generated files | Record separately | Record separately |
| Repeated declarations | Give actual examples | Show what disappeared |
| Missed setup causing a failure | State reproduction | State prevention |
| New abstractions/coupling introduced | None beyond current APIs | Record cost |

If timing is recorded, label it approximate and separate learning/debugging time. File count alone is not success: necessary page design is not infrastructure overhead.

**Done when:** the example works and there is evidence of the actual extension effort. Do not introduce `defineEntity`, `defineDomain`, or `definePageLoad` before completing this baseline.

## 6. Apply only improvements justified by the exercise

For each proposed change, record the concrete repetition/error, smallest remedy, files affected, and a before/after acceptance criterion. Select independently; none of the following is an obligatory framework milestone.

| Observed friction | Smallest candidate change |
| --- | --- |
| Repeated event construction/validation | Generate thin standard command adapters from existing entity definitions; call `executeLocalCommand` |
| Repeated list/get boilerplate | Generate scoped query factories using existing read sessions |
| Forgotten repository registration | Derive standard repository registration from definitions |
| Missing refresh key | Add a consistency test or derive keys from existing registry metadata before inventing a query dependency graph |
| Repeated loader setup | A small wrapper around `deferPage` and `queryDatabase`, proven against actual loaders |
| Fragile generator parser | Replace regex/evaluation with direct TypeScript imports while preserving generated output |
| Generated output drift | Add a non-mutating check mode to the existing generator |
| Documentation gap | Write a verified recipe; no production refactor needed |

The desired generated data surface remains schema/events/standard commands/standard queries. Fill any missing standard pieces incrementally around current APIs. Specialized queries and multi-entity decisions remain hand-written.

1. Implement one chosen remedy at a time.
2. Repeat the Books exercise or update its reference diff; show reduced manual work or prevention of the actual failure.
3. Validate each helper against a relevant existing page/workflow, such as Calendar or Vacations. Do not relocate or rewrite those domains as a mandatory demonstration.
4. Reject the abstraction if it simply moves boilerplate or makes ordinary custom pages harder to follow.
5. Stop once the measured problems are solved. A documented existing API can be the final extension API.

**Done when:** the required standard generation is usable and selected changes improve the measured path without changes to sync/history internals for a new entity.

## 7. Preserve action identity for undo and history

This begins genuinely new history work. Use `local_batches` and existing submission IDs as the starting point. Do not replace all commands with a new envelope merely to attach grouping metadata.

Primary files: `commands/index.ts`, `local-commit.ts`, `store/outbox-request.ts`, `src/lib/ledger/types.ts`, `ledger/src/schemas.ts`, `contracts.ts`, `ledger-app.ts`, and export/import paths.

1. Determine which action identity/grouping already survives locally and remotely. Add only missing accepted metadata, such as action ID and event index/count.
2. Keep upload request identity separate from user action identity; rebase can create a new request for the same action.
3. Preserve uncertain old requests exactly. Resolve them with their original body/hash before preparing replacements. Never rewrite durable requests during a migration.
4. Add compatible server support before new clients emit metadata. Validate complete grouping for new actions and preserve it through polling, WebSocket, backup, and restore.
5. Treat ungrouped legacy events as individual actions unless reliable grouping exists. Never group by similar timestamps.
6. Add device attribution only as needed for the chosen undo scope. Attribution is not tenant authorization.
7. If a metadata/schema change requires event versions or a client compatibility gate, introduce the smallest compatible mechanism now and test old fixtures. A universal upcasting framework is not a prerequisite.

**Tests:** old append/retry works; new grouping survives every transport; two events in one action remain grouped after download/restart; old history remains inspectable.

**Done when:** an accepted action can be identified consistently across devices without migrating all existing forms or erasing old history.

## 8. Complete-action history and Undo

Implemented in `time-travel/action-boundary.ts`, `history.ts`, `undo.ts`, `read-model.ts`, and `commands/index.ts`.

1. Store optional action ID/index/size on accepted raw events. A legacy event remains a singleton.
2. Select only complete accepted action endpoints. Filter visibility before applying pagination and adjacency limits.
3. Select the latest visible pending local batch first; otherwise use accepted log order across personal devices, regardless of device timestamps.
4. Emit one new batch of tombstones for the selected action's non-tombstone members. Preserve raw events and existing tombstone semantics. This reverses the action's effects without deleting the log or replacing unrelated later facts.
5. Rebuild definitions when Undo targets schema or restore events. Persist pending schema work so a failure can be retried.
6. Repeated Undo skips already undone/tombstone-only actions. Redo is not implemented. Inspect the original and resulting accepted boundaries using History.

**Evidence:** complete-boundary pagination, multi-event remote Undo, pending scope selection, durable schema Undo, and browser historical inspection tests. Exact semantics and limitations are in [History and restore](history-and-restore.md).

## 9. Full selected-log restore preview

Implemented in `time-travel/restore-plan.ts`, `read-model.ts`, and the History drawer.

1. Require online capability negotiation and finish synchronization. Refuse pending/conflicted edits or unfinished schema projection.
2. Capture the selected tenant/log and complete accepted head.
3. Materialize isolated current/target snapshots of all static domains and dynamic definitions, including disabled and archived domains. Do not mutate the live tenant registry while previewing.
4. Fail on unknown effective event types. Compare stable record values, including the projected creation/update times, while excluding tenant/log delivery fields.
5. Hash the scope, boundaries, and complete before/after contents. Display added, changed, and removed records with expandable values.
6. Recalculate on confirmation; changed content or scope requires a new preview. External attachment bytes remain outside event replay.

**Evidence:** disabled-domain and archived-dynamic snapshots, unsupported-event rejection, pending-work blocking, deterministic hashes, and browser preview/confirmation.

## 10. Atomic online restore and replay

Owner decisions: selected log, online execution, and normal upload of edits queued before restore. Implemented in `restore-service.ts`, `restore-selection.ts`, `restore-replay.ts`, outbox/sync, and Ledger append/streaming.

1. Persist a single immutable `WORKSPACE_RESTORED` request with an action ID, `targetVersion`, and `expectedLogVersion`. Its local state is `pending_restore`; do not show the target before acceptance.
2. Ledger checks the current log head and target action boundary inside its append transaction. Idempotent replay is checked first, so a lost response can return the original successful result. Stale previews are rejected without rebase.
3. Replay the selected historical prefix, followed by events accepted after the restore. Keep the original suffix for inspection. Nested restore and Undo use the same replay selector for live and historical reads.
4. Use one bounded pointer event rather than replacement events proportional to workspace size. This avoids splitting large restores into visible ordinary batches.
5. Reconcile restore membership, rebuild dynamic definitions/DDL, and replace projected entity rows in one local transaction. Publish the tab-local registry after commit. Advance sync progress only after successful materialization.
6. Preserve the exact durable request across response loss and restart. Never turn a server-accepted append into a rejected local action because a later projection/catch-up operation failed.
7. Overlay old offline edits normally when they are accepted later. Undo of a restore appends a tombstone for the marker; ordinary tombstone-only Undo actions are skipped by repeated Undo.
8. Negotiate `workspace-restore-v1` before sending replay version 1. Once a log contains a restore, reject old read/write/socket clients for that log. Preserve legacy request bodies and singleton events.

**Evidence:** stale previews both before and during append; idempotent response recovery; action boundary rejection; old-client gating; large replay selection; 120-record browser restoration; dynamic/static transaction rollback and retry; late older-timestamp accepted edits. See the limitations in [History and restore](history-and-restore.md), especially full replay cost and external attachment content.

## 11. Document and verify the reference that now exists

1. Write `docs/adding-an-entity.md` and `docs/adding-a-page.md` from the successful exercise and real APIs. Explain which files are generated and which remain custom.
2. Update `docs/offline-sync.md` with verified cursor, retry, and later-accepted-wins semantics. Include the concrete two-client regression as an explanation.
3. Document action history, undo, and restore, including their limits and compatibility behavior.
4. Verify current private tenant isolation with synthetic tenants: direct API scope, offline identity switching, per-tenant caches, disabled routes, and retained history after feature changes. Fix actual failures; do not replace provisioning merely for uniformity.
5. Ask whether domain enablement also needs new server write-capability enforcement. Tenant identity isolation remains mandatory regardless of that product choice.
6. Add old-event and export/import round-trip fixtures for actual schema/protocol changes. Introduce decoding/upcasting only when needed; apply interpretation consistently to ingestion, rebuild, and history.
7. Add scaffolding only if the documented recipe still has repetitive mechanical setup. Never overwrite custom files or generate product UI.
8. Add diagnostic views or performance work only for demonstrated needs. Reuse current Developer tools and timing first; make no unmeasured speed claims.

**Done when:** the app is an understandable reference with a tested extension recipe and honest guarantees. Moving files or introducing a framework is not an acceptance criterion.

## Validation and delivery

Commands below are instructions for implementation, not claims that they have run for this documentation change. Run from the repository root.

Existing focused baseline:

```sh
pnpm test:unit --run src/lib/commands/local-commit.test.ts src/lib/commands/validation.test.ts src/lib/store/outbox-request.test.ts src/lib/store/sync-coordinator.test.ts src/lib/event/projection-builder.test.ts src/lib/time-travel/coordinator.test.ts src/lib/time-travel/mode.test.ts
```

Select checks per change:

- Cursor/storage: the new regression, relevant coordinator/outbox/projection tests, and `src/lib/db/schema-migration.test.ts` if migration changes.
- Generated data APIs: `pnpm generate:entities`, `pnpm check`, focused entity tests, and generator check mode only if implemented.
- Custom pages/helpers: `pnpm check:ts`, `pnpm build`, and `pnpm test` (see [Test portfolio](testing-strategy.md)). Inspect fixtures/configuration first.
- Ledger protocol: `pnpm ledger:check`, `pnpm ledger:test`, client parser tests, and export/import compatibility.
- Final combined integration: `pnpm check:all`, relevant tenant checks, and configured browser suites.

Use applicable local validation and Cloudflare skills when implementation requires them. Browser offline tests must control both request connectivity and the application's online signal. Do not rerun unrelated suites without a change/failure that warrants it.

Keep each fix or justified helper in a cohesive slice. If committing is requested, inspect `git diff --cached` and run `git diff --cached --check`; preserve unrelated work. Retain original event IDs and durable request bodies. Deployment is a separate action; a successful build does not establish live tenant protection.

## What is no longer mandatory

There is no required `core/`/`domains/` restructuring, Calendar/Vacations migration, new command envelope for every caller, query dependency graph, manifest DSL, universal upcaster framework, general simulation harness, or standalone package extraction. Reconsider a mechanism only when a reproduced failure or the extension exercise justifies it. Record the benefit and stop once the problem is solved.

Implementation and validation results are recorded in [architecture evidence](architecture-evidence.md). The extension recipes are [Adding an entity](adding-an-entity.md) and [Adding a page](adding-a-page.md). Keep future improvements tied to reproduced defects or measured extension/performance costs.
