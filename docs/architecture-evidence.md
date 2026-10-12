# Architecture implementation evidence

This is a historical record of the 2026-09-08 implementation. The Undo, restore, and app-wide time-travel paths it describes were retired after Log forking replaced those controls. For current behavior, see [Log history and forking](history-and-restore.md).

## Baseline — 2026-09-06

The existing architecture remains in place. Entry points: entity-definitions.ts and generate-entities.ts; commands/index.ts and local-commit.ts; store/outbox.ts and sync.svelte.ts; event/handlers.ts, projection-builder.ts and rebuild.ts; db/read-repositories.ts and runtime/page-data.svelte.ts; time-travel/history.ts and read-model.ts; features/registry.ts and tenant/config.ts.

Focused baseline: 27 tests passed across seven files (local-commit, command validation, outbox-request, sync-coordinator, projection-builder, history coordinator and mode). Projection schema is 18; ordinary client append limit is 50 events. Re-check these before migrations.

Unrelated working-tree changes at start: ActivityDiary.svelte, Finance month page, tenants.json. Preserve these outside implementation commits.

Confirmed choices: custom pages; generated standard data APIs; private family tenants; later accepted field updates win; inspection, complete-action undo, and full workspace restore. Subsequently resolved: selected log only, online restore, Undo across personal devices, and normal upload of edits queued before restore.

## Progress

- Baseline committed as `ccf3dbf`.
- Cursor regression reproduced: A stored 11 events rather than 12 after B's intervening version 11. The fix ingests append responses through the projection path, advances only contiguous successfully ingested positions, and downloads gaps before finishing upload. Two independent SQLite clients now converge; delayed/duplicate delivery is covered.
- Owner confirmed: restore the selected log; queued pre-restore edits upload normally (later accepted values win); Undo spans personal devices; execution may require online coordination.
- The pnpm version shim stalled under restricted networking after the baseline; checks use the installed Node entry points directly, with the same project configuration.
- Schema 19 repairs all existing stored log cursors to their contiguous prefix in a transaction before marking migration complete. Accepted/pending events and original retry bodies are unchanged. Repair/retry/rollback and legacy schema migration tests pass (7 tests across three files).
- Local command invariants reproduced two failures: equal-time edits selected the earlier random-ID winner, and repeated submissions returned IDs that were never stored. Durable sequence ordering and returning the persisted batch result fix both; focused command/projection/convergence tests pass.
- Incoming-event tests reproduced premature batch acceptance, version-cache regression on old notifications, and raw persistence surviving a failed ordinary projection. Batch acceptance now checks all local events; version updates are monotonic; ordinary projection shares the ingestion transaction. All five real-path convergence tests pass.

## Delivered slices — 2026-09-08

| Area | Implementation/evidence |
| --- | --- |
| Extension | Opt-in Books entity and custom page; ten manual application source edits reduced to seven; four generated data outputs; offline/history/tenant browser exercise |
| Composition | Registered features cannot disappear from navigation because of the optional order list; route dependency test found and fixed missing Developer refresh |
| Identity | Local sequence breaks equal-time ties; duplicate submissions return persisted IDs; distinct concurrent identical-value creates remain distinct |
| Accepted actions | Ledger action ID/index/size survive append retry, paging, streaming, SQL export, logical backup, and local schema 21; old events remain singleton actions |
| History/Undo | Complete endpoints and visibility-aware pagination; Undo selects pending actions then accepted actions across devices; schema/restore Undo remains retryable |
| Restore preview | Full isolated snapshots include disabled domains and archived dynamic data; unknown effective types and unresolved pending work block preview |
| Restore execution | One conditional, idempotent pointer event; online preview/confirmation; stale-head checks before and during append; no optimistic target publication |
| Materialization | Restore membership, definitions/DDL, and entity rows share a transaction; failure injection proves rollback and retry; original raw facts retained |
| Reconnect semantics | Older-timestamp edits accepted after restore win on touched fields; restored historical facts remain inspectable |
| Compatibility | Capability negotiation; old clients blocked on restored logs; legacy append-hash fixture preserved; logical restore uses original action boundaries and accepted positions |

Recent commits: `20de891` online restore UI/outbox; `3eeb9fa` submission identity; `0117b65` atomic restore materialization; `79b990c` late-upload/mobile coverage; `3600ece` logical backup round-trip verification. Earlier focused commits are available in repository history, beginning at `ccf3dbf`.

## Validation and limits

- Full unit suite: 374 tests across 73 files passed. This includes existing tenant route/configuration, command scope, local identity, and database scope tests alongside the new correctness tests.
- Ledger: 13 tests passed using the local Workers runtime; existing cross-application isolation and credential rotation/revocation coverage remains intact. Both Ledger TypeScript configurations pass.
- Reference browser suite: six Chromium scenarios passed. These cover offline CRUD/reload/history/disabled routes, complete remote-action Undo, a 120-record restore and Undo, lost response, stale preview, and an append-time race. The race scenario also passes at 390px via the mobile menu without horizontal overflow.
- Svelte checks: zero errors and warnings. Generator drift check covers 18 entity data APIs. All four tenant configurations and generated Wrangler configurations pass validation. Existing unrelated tenant configuration edits remain outside these implementation commits.
- Production build passes. Existing PWA precache warnings remain; this is not a deployment or offline navigation-cache certification. Browser runs emit the known OPFS main-thread warning while the worker database functions; the mobile menu transition also emits a Svelte `derived_inert` warning without failing the tested flow.

The new documentation is [Adding an entity](adding-an-entity.md), [Adding a page](adding-a-page.md), and [History and restore](history-and-restore.md). Both architecture plans now describe the implemented scope and selected semantics.

Additional server enforcement of enabled domains remains a separate policy choice; strict tenant identity isolation is unchanged. No live provisioning/deployment, family data mutation, production load benchmark, or binary attachment recovery was performed. Logs containing restores currently use full replay for subsequent incoming changes; no speed improvement is claimed. Undo retains tombstone semantics and is not Redo. Logical backup request construction and server replay are covered independently of live administrative provisioning.
