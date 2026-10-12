# Books extension exercise

Books was deleted on 2026-10-06; this page records the exercise as it was measured. [Adding an entity](adding-an-entity.md) now uses Gallery albums as its example.

## Baseline using the existing architecture

The Books example is opt-in and disabled for every family tenant. No family configuration or deployment changed.

Hand-edited application files (10):

- Domain/schema: `event/entity-definitions.ts`, `db/schema-version.ts`.
- Queries: `db/books.ts`, registration in `db/read-repositories.ts`.
- Custom UI: `routes/books/+page.ts`, `routes/books/+page.svelte`.
- Composition: `features/registry.ts`, `features/navigation.ts`, `components/layout/feature-icons.ts`.
- Refresh: `store/sync-invalidation.ts`.

Existing generator outputs (2): `event/types.generated.ts`, `db/schema.generated.ts`. Projection configuration and entity dispatch already derive from definitions; no changes to synchronization, history, bootstrap, or projection handlers were necessary.

Verification support: separate Playwright config, local tenant fixture, Books browser spec, and two updated invalidation expectation lists. The separate reference suite has since been removed; see [Test portfolio](testing-strategy.md).

## Observed friction

1. The first type check caught a missing icon registration. Keep this useful static check; icon choice is legitimate custom presentation.
2. Navigation uses a second explicit ordered feature list; a registered feature can silently disappear. Preserve the current order but append registered features missing from that preferred order.
3. Create/update/remove event envelopes repeat event type, UUID, and timestamp boilerplate. Generate standard command adapters around `executeLocalCommand` using the existing definitions.
4. The basic scoped list query and repository registration repeat table/scope knowledge already in definitions. Generate standard list/get repository factories and expose them under `repositories.records`; retain custom queries.
5. Page lifecycle was already small: `deferPage`, `queryDatabase`, `providePageResource`, `PageDataStatus`, and `CommandOnly` worked without a new page API. Retain them.
6. Refresh registration remains explicit. Add a consistency test for route `depends` keys rather than introducing a new dependency graph.

## Baseline evidence

The local Chromium test passed: add while actually offline; return online and reload without losing the entry; edit/remove; ingest remote accepted events; inspect an earlier version with mutations hidden; deny a disabled Finance route. Transport convergence is covered separately by the real local-store sync tests. This browser test does not claim offline navigation caching or a live Ledger deployment test.

## Selected improvements and follow-up

Generate standard commands and queries, simplify navigation fallback, and check refresh registration. Repeat the same browser test after adoption. Do not move domains or replace working page helpers.

## After the selected changes

The same browser scenario passes using `bookCommands` and `repositories.records.book`. The handwritten Books repository and its registration are gone. Standard data APIs are now generated for all defined entities; custom repositories remain unchanged. Existing page lifecycle APIs were retained.

For a comparable next entity/page: seven application source edits rather than ten (definition, schema version when needed, feature metadata, icon, two page files, refresh key). Four generated outputs replace two. Navigation no longer requires adding a second feature ID to its preferred-order list. UI design and domain-specific queries remain legitimate manual work.

The new refresh consistency check found a real omitted dependency: `app:developer`. It is now included so event/raw-database inspection refreshes with the log. The generator imports typed definitions directly and supports `--check` without mutating files.
