# Local-first personal app: focused architecture plan

Status: historical plan implemented in slices through 2026-09-08. Its app-wide time-travel, Undo, and restore choices were superseded by [Log history and forking](history-and-restore.md); see [implementation evidence](architecture-evidence.md) for the original checks and limitations.

See the [implementation guide](reference-architecture-implementation-guide.md) for ordered steps, file locations, tests, and decision gates.

## Starting point: the architecture already exists

Hearthlog already demonstrates the intended idea: entity definitions drive generated event/database types and projections; commands persist local batches; repositories separate queries from writes; a durable outbox synchronizes with Ledger; isolated historical projections support time travel; tenant configuration selects relevant domains for privately provisioned personal apps.

The work is to strengthen and explain this implementation, reduce demonstrated integration friction, and add missing history capabilities. A new framework, directory layout, or replacement command/page API is not a deliverable by itself.

| Area | Keep and build on | Actual improvement sought |
| --- | --- | --- |
| Event sourcing | Existing events, entity definitions, local batches, projection builder | Correct ordering and replay; compatibility evidence |
| CQRS | `executeLocalCommand`, scoped query repositories, `queryDatabase` | Fix concrete identity/validation gaps; generate repetitive data APIs where useful |
| Synchronization | Existing outbox, retries, Ledger ordering, HTTP and WebSocket paths | Prevent skipped events and prove convergence/recovery |
| Pages | Custom Svelte pages, `deferPage`, contextual clock, write guards | Remove only repetition demonstrated by an extension exercise |
| Tenants | Existing configuration, private identity, scoped storage and deployment | Verify isolation and make provisioning understandable |
| History | Existing snapshots, read-only mode, event inspection | Complete-action undo and full workspace restore |

## Confirmed product requirements

- The owner adds entities and pages in TypeScript with coding-agent assistance.
- Schema, events, commands, and queries should be generated where they follow the standard entity model. Product pages stay custom.
- Each family member has a strictly private tenant with relevant domains. No sharing.
- Later server-accepted uploads win conflicting field values, with earlier accepted changes recoverable in history.
- History supports inspection, Undo across personal devices, and restoring the selected event log.
- Restore requires an online connection. Queued edits from before restore upload normally and later accepted field values win.

These requirements do not prescribe domain manifests, new factories, a command bus, or a core package. Extend current mechanisms first.

## Track A — Fix and verify correctness

Start with the synchronization cursor risk identified in code inspection: upload acknowledgement can advance the downloaded head past an intervening remote event. Reproduce it with two independent client stores, fix the smallest responsible path, and repair previously overstated cursors without deleting pending work.

Then add focused evidence for pending-to-accepted ordering, equal-timestamp local edits, response loss, restart recovery, and scope changes during asynchronous work. Treat suspected gaps as test hypotheses until reproduced. Broaden production changes only when the tests establish a failure.

Preserve these contracts:

1. Download progress denotes a contiguous persisted prefix; observed server head is a separate fact.
2. Projected progress denotes successfully materialized data under the active projection policy.
3. Local action batches survive restart, and uncertain uploads retry their original request unchanged.
4. Later accepted field patches win; pending local order is deterministic; old accepted facts remain available.
5. Incremental projection, rebuild, and history agree at the same accepted boundary.
6. Tenant/log scope cannot change underneath an in-flight operation.

**Outcome:** a small set of concrete fixes and executable guarantees, not a compulsory synchronization rewrite.

## Track B — Measure the existing extension path

Add one representative entity and custom page using today's architecture before introducing abstractions. Use a local-only Books example with title, author, reading status, notes, and optional finish date; do not enable it for family tenants or deploy it as part of the exercise.

Record all hand-edited files, generated outputs, copied code, registration points, and failures. Separate legitimate domain/UI work from infrastructure wiring. Verify ordinary offline edits, remote refresh, history, and tenant gating using existing helpers.

Classify each friction point:

- Necessary domain or custom UI code: retain it.
- Repeated declaration already present in entity definitions: derive it from those definitions if practical.
- Easy-to-forget setup: prefer a small helper, check, or documented recipe.
- Suspected complexity without a concrete failure: leave unchanged.

Implement only the selected improvements, then repeat the exercise and compare the manual work. For standard commands and queries, reuse or generate thin adapters around existing command and repository APIs; rich workflows remain hand-authored. Check any helper against an existing richer page/workflow without migrating that domain wholesale.

**Outcome:** an evidence-backed extension recipe and fewer demonstrated integration steps. If current mechanisms are already sufficient, documentation and a test can be the complete result.

## Track C — Add the genuinely missing history capabilities

Keep the snapshot engine. Add only the metadata and behavior required to make accepted user actions understandable across devices.

1. Preserve action/batch grouping through Ledger where existing metadata is insufficient. Keep old events readable as individual actions when grouping cannot be recovered reliably.
2. Show complete accepted actions and inspect their historical boundaries. Keep pending local activity distinct. Full before/after record differences are available in restore previews.
3. Implement Undo as a new complete batch of tombstones under the existing replay semantics. Select the latest visible pending action first, otherwise the latest complete accepted action across devices. Repeated Undo skips tombstone-only actions; it is not Redo.
4. Build a restore preview by comparing current state with an accepted historical boundary.
5. Commit restore as a new action that reaches the chosen target without deleting subsequent history. Make it recoverable and atomically visible, including at sizes beyond an ordinary append batch.

Protocol additions, compatibility gates, or large-operation staging are justified by these features, not prerequisites for documenting or extending an ordinary entity. Select the smallest viable restore mechanism after confirming scope and measuring limits.

**Outcome:** action-level undo and complete workspace restore. An implementation limited to small restores is an intermediate result, not fulfillment of the requirement.

## Track D — Make the current app a clear reference

Document the real paths: entity definition → generated artifacts → local command → outbox → accepted event → projection → custom page/history. Publish the extension exercise and focused recovery tests as examples.

Verify existing private tenant isolation and describe provisioning from current configuration. Fix demonstrated isolation failures promptly. Decide separately whether domain enablement is a server-enforced write permission or application composition; do not conflate that choice with private tenant isolation.

Record existing schema/projection compatibility behavior using sanitized old-event fixtures. Add explicit event versioning/upcasting only when a real event change or the history protocol requires it. Preserve old pending request bodies and hashes through every migration.

**Outcome:** a reference implementation whose existing simplicity and guarantees are easy to understand. No claim of automatic performance improvement; optimize only from measured problems.

## Resolved decisions and remaining policy choices

| Decision | Selected behavior |
| --- | --- |
| Restore scope | Selected event log only |
| Connectivity | Online execution with an atomic expected-head check |
| Undo scope | Personal devices; latest pending local action first |
| Old queued edits after restore | Upload normally; later accepted fields win |
| Restore mechanism | One accepted pointer event selecting a historical prefix; later events overlay |
| Remove/recreate | Existing projector semantics retained |
| Domain permissions | Existing tenant identity isolation and app capability configuration retained; additional server write enforcement is a separate product choice |

See [History and restore](history-and-restore.md) for the actual Undo policy, compatibility gate, and performance/attachment limits. Restore and full-log preview cover disabled domains without exposing them as ordinary enabled pages.

## Delivery order and stopping rules

1. Reproduce and fix the cursor problem, including existing local state.
2. Verify related invariants and fix only reproduced failures.
3. Perform the extension exercise with the current architecture.
4. Make the smallest improvements supported by its results; repeat and measure.
5. Add action grouping/undo and full restore with their necessary compatibility work.
6. Finish reference documentation and tenant/recovery evidence.

Stop architecture refactoring once the measured problem is solved. Do not require moving Calendar or Vacations, creating `core/` and `domains/`, replacing `deferPage`/`queryDatabase`, or migrating all forms to a new command envelope. A future extraction needs a documented before/after benefit.

Defer standalone packages, generalized domain/query registries, universal command buses, runtime entity builders, CRDT adoption, universal upcaster infrastructure, new lease protocols, and checkpoint systems until a concrete requirement warrants them. A reproduced correctness failure can justify one of these mechanisms, but its name or architectural appeal cannot.

## Completion criteria

- The cursor regression and relevant convergence/recovery scenarios pass.
- The extension exercise documents the actual work and verifies inherited behavior.
- Selected generation/helper improvements demonstrably reduce repetition without displacing working APIs.
- Complete-action undo and full workspace restore meet the chosen semantics.
- Existing family tenant isolation and provisioning remain intact and verified.
- The reference explains existing capabilities accurately, without presenting them as newly delivered.

Keep changes in cohesive slices, preserve unrelated working-tree changes, and retain existing events and pending operations. Documentation updates do not authorize deployment.

## Delivered reference

The Books exercise reduced comparable manual source edits from ten to seven. Standard commands and scoped queries are generated; pages remain custom. Cursor repair, durable ordering/retry fixes, complete-action metadata and Undo, full-log restore preview/confirmation, and atomic local restore materialization are implemented. Read [Adding an entity](adding-an-entity.md), [Adding a page](adding-a-page.md), and [History and restore](history-and-restore.md). Deployment and production-scale performance validation are separate work.
