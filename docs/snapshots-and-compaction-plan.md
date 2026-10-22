# Snapshot baselines and log compaction

Status: implementation plan only. No runtime, infrastructure, or production data changes are authorized by this document.

Date: 2026-10-22.

## Agreed behavior

- A snapshot captures the complete accepted state of one log at a complete action boundary. It accelerates replay without removing source events.
- Compaction keeps the same application ID, log ID, event IDs, action IDs, entity versions, and monotonic log-version sequence. It moves an accepted prefix out of the active event table after its baseline and archive have been verified.
- Original events remain in a private archive. Permanent deletion is a separate explicit action, never a side effect of compaction or an automatic retention policy.
- Devices behind the compaction boundary reload the baseline without losing pending work. Devices already beyond the boundary can continue from their existing verified cursor.
- Existing domain records, including old invoices, transactions, scenes, and their current file references, survive compaction. Compaction removes edit history from the active store; it does not remove old business records.

Initial defaults: manual operations, per-log scope, no automatic archive expiry, no automatic snapshot schedule, and no automatic paid-plan upgrade. Snapshot creation and compaction are separate controls. Compaction can offer to create the prerequisite snapshot as part of its job.

## Current implementation and affected areas

| Area | Current behavior | Required change |
| --- | --- | --- |
| `packages/runtime/src/history/point-snapshot.ts` | Builds temporary in-memory history views from raw events. | Keep history inspection; add a separate persistent checkpoint format and baseline-aware history reads. |
| `packages/runtime/src/event/projection-builder.ts`, `rebuild.ts` | Reconstruct entities and rebuild projections from raw events. | Project from baseline state plus accepted suffix plus pending local overlay. |
| `packages/runtime/src/store/sync-progress.ts` | Requires contiguous event positions starting at zero. | Treat an atomically installed, verified baseline as covering the prefix through its version. |
| `packages/ledger/src/ledger-app.ts`, `schema.ts` | Stores complete event payloads, claims, append receipts, forks, and socket cursors. | Add checkpoint metadata, archive manifests, maintenance jobs, compatibility checks, and archive-aware reads. |
| `packages/contracts/src/history/replay-selection.ts` | Resolves restore, legacy excision, and tombstone directives against accepted history. | Define a shared replay resolver that can obtain older history when a directive crosses a baseline. |
| `packages/cloudflare/src/calendar-feeds.ts`, `log-forks.ts` | Read events starting at zero. | Use shared baseline-aware state reads or explicit archived historical replay. |
| `hearthlog-module-stash/src/server/ledger.ts`, `media-index-state.ts` | Builds media authorization state from accepted events, with full replay after replay directives. | Seed from the canonical baseline and use the shared history resolver for cross-boundary directives. |
| `packages/ledger/src/transfer.ts`, `scripts/logical-backup.ts`, `src/sqlite-export.ts` | Export/import contracts assume all events are in SQLite. | Include checkpoint/archive assets and preserve historical and identity guarantees. |
| `packages/contracts/src/index.ts`, SDK, composer, tenant tooling | Describe entities, module contracts, server contributions, and bindings. | Generate checkpoint codecs and private archive bindings; version compatibility across consumers. |

The current fork copies the entire event prefix; it is not a compaction mechanism. Server consumers and maintenance commands must be audited across the module repositories before enabling physical deletion.

## 1. Canonical baseline and replay contract

Add versioned contracts in `@hearthlog/contracts`, exported through the SDK where modules need them. Keep them independent of Svelte, browser SQLite, and tenant-specific projection tables.

Use the following distinct concepts:

- `throughVersion`: the last complete accepted action represented by a checkpoint.
- `compactedThroughVersion`: the highest accepted version routed to archive rather than the active event table; zero before compaction.
- `storageGeneration`: a monotonic storage-layout generation used to detect stale maintenance plans and baseline installations. This does not reset event versions or force every current device to reload.
- `historyAvailableFromVersion`: the earliest historical point still reconstructible after any separate archive deletion; compaction alone does not advance it.
- `headVersion`: the existing highest accepted event version, unchanged by snapshot publication or compaction.

A checkpoint manifest identifies application/log scope, checkpoint ID, boundary, format version, replay-semantics version, producer revision, codec versions, page counts, record counts, byte counts, SHA-256 digests, and any prior checkpoint dependency. State chunks are immutable and bounded; a published baseline is independently loadable rather than an indefinitely growing chain of checkpoints.

Canonical state contains:

- Entity IDs, module/type ownership, complete raw field values, key-presence information, explicit nulls, creation/update ordering metadata, and removed-entity state. Preserve payload keys not currently projected; do not cast or default raw values into an irreversible SQL representation.
- Entity claims as of the boundary, including claims for deleted or restored-out entities. The latest accepted entity version and the version of data selected by a restore are different concepts and must remain separate.
- Dynamic entity definitions, updates, and archived definitions, with their versioned interpretation.
- File ownership/reference data required by media authorization and file lifecycle contributors. Include references needed by archived history as well as current state.
- Enough source-position metadata to seed ordering/version caches and prove coverage through the complete boundary.

Generate the standard add/update/remove codecs from entity definitions. Define an explicit versioned contributor contract for nonstandard module state and file-reference interpretation. Build snapshots using all contracts that own accepted data, including disabled features. An unavailable or unrecognized codec blocks publication/compaction for that log; never silently omit its state. If a new codec cannot reproduce older accepted payloads, preserve/recover from source history rather than inventing defaults.

Define one shared state reader for a chosen accepted boundary: choose a usable baseline, replay the required suffix, and resolve any dependency on earlier history. Ordinary ordered changes use the fast baseline-plus-suffix path. A restore, legacy excision, or tombstone that reaches behind the baseline triggers archive-assisted reconstruction from a suitable earlier point. Never apply a tombstone to an already folded baseline as if it were an ordinary field update.

Keep synthetic baseline records separate from user events: installing a checkpoint must not create audit actions, invoke integrations, or trigger file uploads and other domain side effects.

Acceptance: full replay and checkpoint-plus-suffix produce identical canonical state, SQL projections, version claims, and relevant file authorization at every tested complete boundary, including after cross-boundary replay directives.

## 2. Storage, trusted construction, and resumable jobs

Use a dedicated private R2 Standard archive/checkpoint resource, configured through tenant/shared-stack tooling rather than handwritten generated configuration. Shared Ledger deployments can use one archive bucket with application/log-scoped object keys; access always passes through authenticated code. Keep it separate from publicly served media and caching buckets.

Ledger's existing per-application Durable Object remains authoritative for log metadata, claims, identity receipts, maintenance state, and publishing pointers. Keep bulk checkpoint/archive bytes in R2. No class, binding, or existing Durable Object identity is renamed.

Implement snapshot construction in trusted server code using generated codecs and explicit module contributors, without importing browser runtime code into Ledger. The per-tenant gateway worker supplies tenant-specific codecs; Ledger supplies exact accepted source ranges and publishes only a scoped job's verified result. A browser requests an operation and polls progress; it cannot publish a user-supplied state blob as authoritative. Internal builder credentials/capabilities must be restricted to their application, log, job, boundary, and manifest digest.

Persist jobs, page progress, expected generations, source boundaries, verification results, and failure reasons. Use bounded work steps that can be invoked by the UI or a maintenance CLI and resume after interruption. The browser need not remain open for data correctness. Do not rely on in-memory state or a long `waitUntil` to finish a large job. If background continuation is added, keep one resumable alarm dispatcher per existing application object rather than one alarm per log.

Object storage and SQLite do not share a transaction. Upload immutable chunks and validate their digests before a short synchronous SQLite transaction publishes their manifest pointer. External I/O stays outside that transaction; recheck access, job ownership, and storage generation when committing. Concurrent appends beyond a fixed source boundary are allowed and do not invalidate the prefix being captured. Serialize conflicting compaction, purge, import, and log-deletion operations and pin assets used by historical readers/jobs.

Acceptance: interrupted uploads remain unpublished, retries reuse the operation ID, orphan cleanup cannot delete referenced assets, and an interrupted job resumes from its persisted page cursor.

## 3. Snapshot creation without deletion

1. Authorize the operation through the existing same-origin gateway and capture boundary `B`, ending a complete accepted action. Exclude all pending, rejected, and local-only events.
2. Pin the source history/layout for the job. Read exact accepted ranges through `B`, from existing archive segments plus active events if necessary.
3. Build canonical state in bounded passes. Reuse a previously verified baseline when its codecs and replay dependencies permit it; allow a full-source verification path for rollout and recovery.
4. Write canonical chunks and a candidate manifest to immutable private keys.
5. Verify scope, boundary completeness, source-range coverage, checksums, counts, claims, and file references. Checkpoint equivalence with the existing SQL projector is a release gate; during initial rollout, compare a candidate against a separately materialized full replay before publication.
6. Publish the checkpoint pointer atomically. Preserve the previous verified checkpoint until the new one is usable. Source events are untouched.
7. Return a receipt containing checkpoint ID, boundary, counts, sizes, digests, and completion state. Record maintenance audit metadata separately from the domain event stream.

Acceptance: a fresh reader can reconstruct state through `B` from the checkpoint alone, then catch up from `B + 1`; failure never removes the previous working replay path.

## 4. Browser bootstrap, normal projection, and offline work

Add local migrations for checkpoint metadata, canonical baseline state, and baseline coverage. Rebuild and per-entity projection must read a unified scoped source: installed baseline + accepted suffix + pending local overlay, with the same ordering/null/deletion semantics as existing replay. Keep filtering and aggregation in SQLite.

Extend sync bootstrap metadata with the available checkpoint, compacted boundary, storage generation, and supported protocol versions. A new device may use a snapshot even before compaction. A cursor below `compactedThroughVersion` receives an explicit baseline-required response, never an empty event page that looks like successful catch-up. A compatible device already at or beyond that boundary can fetch the live suffix normally.

Installation procedure:

1. Coordinate the active scope through the existing tab/schema/sync locks. Pause that scope's uploads and realtime ingestion while preparing a replacement accepted base; do not block unrelated logs.
2. Leave the existing raw pending events, outbox bodies, submission IDs, request IDs, and local sequence information intact. Reconcile an already accepted request by its original receipt rather than appending it again.
3. Download and verify checkpoint pages into staging tables. Unsupported format or missing/corrupt pages leaves the old local state usable.
4. In one local publication transaction, install baseline records/claims/coverage, preserve any already verified accepted suffix, reapply the pending overlay, and switch read targets/cursors. Never publish a partially loaded baseline.
5. Replay the contiguous accepted suffix starting at `B + 1`. A verified baseline covers positions through `B`; upload acknowledgements still cannot advance the download cursor across missing positions. Update progress-repair migrations and version-cache rebuilding to understand baseline coverage.
6. Resume the original queued requests. Normal conflict handling parks stale work for review; no silent discard, payload rewrite, or blind retry with a newer base version. Notify other tabs and refresh the existing scoped data targets.

Add checkpoint-aware HTTP errors and socket resync reasons, and reject unsupported old clients clearly after compaction. Capability negotiation must cover read, append, and WebSocket paths; an old cached frontend must not misinterpret a compacted log.

Acceptance: fresh device, stale device with pending edits, lost append response, multiple tabs, schema/module upgrades, feature disable/re-enable, and offline restart all converge without lost or duplicated user actions. Local compaction may remove covered accepted raw rows after publication; preserve rejected diagnostics and pending work.

## 5. Archive-aware historical reads and every replay consumer

Provide a shared logical history reader that stitches immutable archive segments and the active suffix at an explicit boundary. Index archive pages by version range and retain an action summary/boundary index for paginated timeline reads. Detect holes, overlaps, or missing objects explicitly. Do not download all archives for ordinary sync or every history-page request.

Update these consumers before enabling compaction:

- History list, before/after comparisons, time travel, restore validation, tombstones, and legacy excision interpretation. Fetch historical ranges on demand into isolated scoped staging tables; keep ordinary offline work independent of archive downloads. Older history requires connectivity unless its needed data is already cached.
- Restore/fork at an archived point. Resolve the exact original accepted history and existing action boundaries; preserve entity claims and fork/file lineage. Avoid direct `INSERT ... SELECT` assumptions that all source events remain in SQLite. A fork at the current state can use a baseline; historical forks must retain the original point semantics.
- Stash media index and its fallback event reader. Seed its ownership state/cursor from a baseline, preserve current session/app/log checks, and rebuild correctly after cross-boundary directives. Its ability to start from an empty Durable Object is a required test.
- Calendar feed folding and rendering, including cache invalidation when storage layout changes but the domain head does not.
- Gallery file-reference checks and module file contributors, including log-scoped invoice files and Stash's ancestor-log file access. Compaction alone must not delete media or historical file versions.
- Administrator event browsing/search/counts. Distinguish total logical events from active payload rows and archived rows; make archive search explicit rather than silently returning incomplete results.
- Logical backup/restore, identity-preserving transfer/import, checksums, tenant migration, and application/log deletion. Version their formats; include immutable objects and manifests, claims/identity receipts, storage boundaries, and a completeness check. A SQLite-only export after compaction must be labeled incomplete without its archive bundle; retain an explicit full portable export path.

Pin a logical read boundary and its archive manifests for long reads, exports, and forks. Do not let a concurrent compaction or purge create a mixed-layout result. Imports become writable only after all archive/checkpoint objects and identity metadata have been verified.

Acceptance: all consumers reproduce pre-compaction behavior from an empty local/server cache, and an exported compacted log restores with its original identities and complete retained history.

## 6. Compaction, publication, and retry identity

Offer a preview tied to a verified baseline at `B`: active payload rows/bytes removable, archive/checkpoint sizes, retained metadata, expected read/write work, historical availability, and device reload behavior. Estimates are estimates; do not promise a particular SQLite file-size or billing reduction just from deleting rows.

Compaction procedure:

1. Create/reuse a verified, independently loadable checkpoint covering `B`. Reject stale previews if their chosen baseline, generation, or eligibility changed. Appends above `B` are permitted.
2. Archive the not-yet-archived prefix through `B` in bounded immutable segments, preserving exact IDs, versions, payloads, timestamps, actors, and action metadata. Verify contiguous original-version coverage and digests. Reuse existing segments rather than copying the entire old archive on every compaction.
3. Preserve entity claims and durable identity metadata before removing any source rows. Maintain compact event-ID and action-ID registries so their uniqueness survives removal of the original unique-index rows. Keep append-request hashes and original accepted version ranges; add no silent receipt TTL.
4. Publish the verified archive manifest, baseline pointer, new `compactedThroughVersion`, and storage generation together in a short SQLite transaction. Realtime readers behind the new boundary are told to load a baseline.
5. Delete covered active payload rows in bounded, idempotent transactions, retaining events above `B` and every pending write. During this phase the shared reader uses the published layout, not the physical presence of duplicate payload rows. Persist the deletion cursor and report `reclaiming` until cleanup finishes.
6. Recheck logical counts, checkpoint-plus-suffix state, receipt replay, and archive readability; then mark the job complete. Subsequent compaction advances the boundary without resetting versions.

Existing append receipts sometimes reconstruct their response from `first_version`/`last_version` in `log_events`. Refactor receipt replay to read those immutable ranges through the archive reader outside synchronous SQL transactions, rechecking access as needed. A lost response retried after compaction must return its original acceptance and never produce a new event. Keep checks for reused request content, event IDs, and action IDs effective across the archive boundary.

Retaining claims and identity registries means compaction does not eliminate all metadata growth. Report that cost honestly; payload removal, avoided scans, and smaller device replay are the initial benefits. A future bounded receipt-retention policy would require a separately designed protocol change.

Acceptance: ordinary appends continue during prefix preparation, a crash after publication/before deletion is safe, repeated deletion batches are harmless, and a delayed original request still resolves correctly after its payloads have moved.

## 7. Separate archive deletion

Archive expiry remains disabled. First deliver snapshot creation and archive-backed compaction completely. Reserve a separate `Delete archived history...` operation rather than adding a purge flag to compaction.

Before implementing that destructive operation, require a dependency preview and these contracts:

- Identify active baselines, existing restore/tombstone/excision dependencies, in-flight reads/jobs, retained fork/file lineage, and receipt responses that require the proposed archive range. Deny deletion while unresolved dependencies exist, or materialize an independent replacement first without rewriting accepted events.
- Keep an independently loadable current baseline and any retained historical boundary states valid. Advance the explicit history-availability floor and make unsupported old history/restore targets fail visibly.
- Preserve compact acceptance receipts even if the original event payload is deleted. This needs a capability-gated `already committed` receipt response for upgraded clients; do not discard deduplication identities or pretend that an exact historical event response can still be reconstructed.
- Reject future directives that require unavailable history, while retaining queued offline work for review. Never reinterpret a historical target silently.
- Confirm and audit the exact range being deleted; publish loss of availability before resumable physical object removal. Do not claim that deleting an archive erases independent backups, cached device history, or current domain records.

This operation is a follow-on delivery with its own review and data-loss confirmation. It is not a prerequisite for using snapshots or archive-backed compaction and is never executed by this plan.

## 8. Controls, progress, and operational budgets

Add a small maintenance section to the existing log controls/history surface, using current shell components and command-availability rules:

- `Create snapshot`: accepted boundary, last verified snapshot, estimated work, and completion receipt.
- `Compact log...`: concrete preview and confirmation, archive retained by default, and resumable progress.
- `Archived history`: date/version ranges, access to retained actions, and clear online availability.

Show job states such as preparing, verifying, publishing, reclaiming, complete, failed, and paused for budget. Failed jobs offer retry with the original operation ID; a pause for quota is not reported as corruption or successful completion. Local pending work need not block snapshotting the accepted prefix.

Instrument bounded pages with consumed SQL `rowsRead`/`rowsWritten`, R2 operations/bytes, wall time, checkpoint size, source event count, and suffix length. Do not log payloads or credentials. Batch by bytes and work budget as well as event count; support unusually large valid events.

Cloudflare currently counts SQL deletes as writes. Configure conservative per-job write/read budgets, reserve capacity for normal traffic, and support resumption on later quota windows. Account-wide usage may include other applications, so correlate measurements with account metrics instead of assuming a per-job budget guarantees free-tier compliance. Creating identity registries and deleting a large prefix can require multiple days on the free tier. Avoid writing an entire prefix into temporary Durable Object tables merely to move it to R2.

## 9. Implementation sequence and release gates

| Delivery | Scope | Gate before proceeding |
| --- | --- | --- |
| 1. Contracts and replay model | Canonical state/codecs, replay resolver semantics, fixtures, protocol metadata, compatibility design. | Exact equivalence against existing SQL projection and replay selection, including historical directives and disabled modules. |
| 2. Archive resource and snapshot writer | Generated bindings, server builder, immutable chunks, job state, verification, snapshot API. | Restart/failure safety and verified snapshots; no event deletion. |
| 3. Runtime adoption | Local migrations, baseline installation, projection/rebuild/version-cache changes, HTTP/socket sync, pending-work preservation. | Fresh/stale/offline/multi-tab devices converge against snapshot plus suffix. |
| 4. Consumer and portability support | Stash, calendar, history, forks, files, admin, backup/transfer/import, maintenance compatibility. | Empty-cache consumers and full export/import round trips pass; no unsupported production consumer remains. |
| 5. Snapshot controls and observation | Manual UI, preview/receipts, representative measurements, per-log readiness flag. | Snapshot use is proven on production-like data; archive restore/reconstruction drill succeeds. |
| 6. Archive-backed compaction | Archive publication, identity registries, budgeted cleanup, compaction UI, crash recovery. | Destructive cleanup stays disabled until deliveries 1-5 are satisfied for the target log. |
| 7. Separate archive deletion | Dependency analysis and new receipt semantics, followed by an explicit deletion control. | Independent design review and confirmation; no automatic retention. |

Deploy compatibility support before activating it: Ledger/storage protocol first, then runtime/gateway and all module consumers, then snapshot creation/use, then compaction for a verified log. Keep compaction disabled by default until readiness is recorded. Release core, SDK, affected modules, and tenant composition in dependency order through the existing release coordinator; this plan does not authorize publication or deployment.

Before any physical deletion, retain a verified full export and record the oldest compatible reader/server release. After compaction, rollback must use a baseline-aware version or rehydrate the exact archived prefix before using old code; additive SQL migrations alone do not make old binaries safe. Rehydration restores original events and IDs, not newly appended substitutes.

## 10. Verification and completion criteria

Use a focused data-integrity suite rather than duplicating implementation details:

1. Replay equivalence: complete action boundaries, explicit null versus absent keys, unknown payload fields, defaults/casts, removed/recreated records, dynamic schemas, disabled/re-enabled features, restores, legacy excisions, and tombstones of earlier directives.
2. Sync: fresh baseline bootstrap, accepted suffix gaps, lost acknowledgement retry, unchanged-entity pending work, conflicting pending work, local restart, multiple tabs, schema rebuild, incompatible cached client, and corrupt/missing checkpoint chunks.
3. Maintenance: append during build, overlapping job rejection, crash after each publication/deletion transition, repeat compaction, resumable budget pause, archive corruption, and explicit historical-range unavailability.
4. Identity and scope: cross-app/log access rejection, forged candidate rejection, revoked access during a job, deleted-entity claims, reused event/action IDs, and accepted requests retried from archived ranges.
5. Consumers and recovery: cold Stash index and private-media authorization, cross-boundary revocation/restore, calendar feed output, archived history inspection, historical fork/files, full backup/transfer round trips, and rollback by exact rehydration.
6. Performance: representative logs with many records and with many edits to a few records; compare full replay, checkpoint bootstrap, ordinary save, sync/import, archive history access, and compaction maintenance cost. Set numeric acceptance budgets from these measurements; do not assert an unmeasured speedup.

During implementation, run the relevant current repository checks: `pnpm -C dev check:ts`, `pnpm -C dev test:unit --run`, `pnpm -C dev ledger:check`, `pnpm -C dev ledger:test`, `pnpm -C dev frontend:worker:typecheck`, `pnpm -C dev build`, and the existing browser journey. For generated contracts/bindings and package exports also run generation/module checks, script tests, `pnpm test:integration`, the relevant Worker dry-runs, package/tarball checks, and tenant composition-lock validation. Run the affected module's own checks as well. Choose exact targeted invocations from the scripts present when implementation begins; tests listed here are planned, not executed results.

Completion means both manual snapshot creation and archive-backed same-log compaction work through the visible UI, preserve all current domain data and pending work, support every deployed reader and export path, and produce verifiable receipts. Archive deletion remains a separately gated feature. No implementation, benchmark result, release, or deployment is implied by this planning document.

## References

- [Event sourcing and snapshots](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing): snapshots accelerate replay while the original stream remains available.
- [Durable Object SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): synchronous transaction boundaries, storage size, and consumed-cursor metrics.
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/): object read-after-write consistency; SQLite/R2 publication still needs an application-level protocol.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): current free-tier budgets and delete accounting; recheck before choosing production work limits.
