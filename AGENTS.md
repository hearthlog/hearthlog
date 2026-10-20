# AGENTS.md

Instructions for coding agents working in this repository. Read this file before
making changes; it is the project's single source of truth for conventions and
the definition of done.

## What this is

Hearthlog is an offline-first SvelteKit 5 monorepo. The browser keeps event history and
read models in SQLite WASM (OPFS), stays usable offline, and synchronizes with
**Ledger** — a Cloudflare Worker event store backed by SQLite Durable Objects.
A same-origin frontend Worker (`@hearthlog/cloudflare`; its entry is generated into `.generated/sites/<id>/worker.ts`) authenticates browser traffic and
proxies `/api/ledger` to Ledger through a service binding.

- **Event sourcing + CQRS.** Commands validate and append immutable events;
  projections materialize queryable read models. HTTP append/replay/recovery is
  authoritative; WebSockets only deliver ordered live batches and reconnect
  signals.
- **Multi-tenant.** `tenants/<id>/` is the single source of truth for a deployed
  site: features, branding, authorized emails, and shared infrastructure.
- **Credentials stay server-side.** The frontend Worker injects long-lived
  credentials; they are never bundled into browser code.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/` | `@hearthlog/contracts` (module manifest and the pure shared kernel: tenant config, feature registry, entity definitions), `@hearthlog/shell` (layout and navigation, the log panel and history, the calendar, sync status; the host's pages are being moved in), `@hearthlog/runtime` (the offline runtime: database, events and projections, commands, the outbox and sync, the Ledger client, history, page lifecycle), `@hearthlog/ui` (the design system: primitives, overlays, the generic data table, and the small stores they share; it imports no other `@hearthlog` package), `@hearthlog/sdk` (the API modules import), `@hearthlog/czech` (Czech public holidays, working-time rules, and the flat-rate tax estimate: a plain library, not part of the SDK), `@hearthlog/ledger` (the Ledger Worker: Elysia application, SQLite Durable Objects, event validation, tests, and the logical backup scripts; it imports `contracts` only), `@hearthlog/cloudflare` (the gateway Worker code: Access sessions, the Ledger and admin proxies, assets, fences, log forks, AI decisions, service integrations, calendar feeds; it imports `contracts` only), and `@hearthlog/tooling` (the `hearthlog` CLI and the tools behind the scripts, in folders by job: `tenants` configuration, `deploy` planner/apply/ensure/copy/split/backup, `compose` and `generate` for the module catalog and generated files, `check` for layers, module boundaries, and tenants, `security` for the push audit, `vite` for the site's Vite configuration (`hearthlogConfig()`, which a site's `vite.config.ts` calls) with its plugins and the local gateway stand-ins, `dev` for the local Ledger credential, `init` for `hearthlog init` (renders `templates/tenant/` into a new site; the `hearthlog` bin runs `build`, `init`, and the CLI), `public-workers` config; commands treat the nearest directory with `tenants.json` or `tenants/` as the site (`hostRoot()`), and the repository's own checks find the platform checkout through `PLATFORM_ROOT`, both in `src/root.ts`) |
| `packages/runtime/src/event/` | Entity definitions, commands, projections, rebuild |
| `packages/runtime/src/db/` | SQLite schema, migrations, read repositories |
| `packages/runtime/src/ledger/` | Ledger HTTP/WebSocket client |
| `packages/runtime/src/store/` | Reactive stores, outbox, sync coordinator |
| `packages/runtime/src/runtime/` | Page data/command context plumbing |
| `packages/runtime/src/native/` | The page's side of the native-shell bridge (no-op in a browser) and of the native engine bridge (`bridge.ts`, `engine.svelte.ts`) |
| `packages/native/` | `@hearthlog/native`: the Swift shells that open the deployed site as a Mac and an iOS app (`swift/`) and the tools that build them for one tenant (`src/`: Mac build, iOS project, icons, re-sign), run as `hearthlog apple:mac|ios|test|resign`; `swift/Engine/` is the hidden engine web view native apps read the runtime through (bridge version 2, `packages/runtime/src/native/bridge.ts`, on the `/native-engine` route), `hearthlog apple:engine <site>` builds a window that shows what it reports, and `--app <dir>` builds a module's native app from its Swift instead (`modules/stash/apple`). A module's native API is its manifest's `native` (`contract` with TypeBox schemas, `api` implementing it, `swiftTypes` that `hearthlog apple:types` writes and `check-module` checks); output goes to the tenant's `.apple-build/`, device settings to its gitignored `resign.local.json` |
| `packages/cloudflare/types/` | The `Env` declaration of the gateway Worker (`wrangler types` output from the development site's generated `st` config, `dev/.generated/sites/st/wrangler.jsonc`, with every binding any module may use) and its secrets; tenants take it from the package and run no `wrangler types` (`pnpm -C dev frontend:worker:types` regenerates it with the modules linked in, through `pnpm test:integration frontend:worker:types`; `frontend:worker:types:check` is the drift check) |
| `dev/` | The development site: a workspace member laid out like a site `hearthlog init` writes, with its own `package.json` (the app's dependencies and every site script), `tenants.json` (placeholder shared infrastructure), `tenants/st/` (its one site, module-less), `vite.config.ts`, `tsconfig.json` (which also type-checks the packages and `tests/`), `tsconfig.worker.json`, `.env.example` and `.dev.vars.example`, and `ledger/` (the Ledger Worker's generated `Env` types, `pnpm -C dev ledger:types`, the secrets declaration, and `.dev.vars.example`). Its build writes the gitignored `dev/.generated/` (only its `package.json` is committed): the package `@hearthlog/generated` the platform packages import (`src/`: module catalog, icons, repositories, entity types, schema, data APIs, Ledger event schemas), `sites/<id>/` (`tenant.ts`, `app.html`, `server-modules.ts`, the Worker configs), `shared/` (the Ledger, calendar feed, and Gallery Worker configs), and the SvelteKit host (`routes/`, `app.css`, `service-worker/`, `static/`, `app.d.ts`). An optional `dev/src/routes/` adds site routes; the core routes are thin files the build writes to `.generated/routes/` from `packages/tooling/src/host/core-routes.ts`. Modules are not in this repository: the first-party ones live in their own repositories and install as `@hearthlog/module-*`, and the composer also picks up `dev/modules/<name>/` (what `pnpm -C dev module:new` writes; the manifest is the `ModuleManifest` type in `packages/contracts/src/index.ts`) |
| `tests/` | Everything only tests use: the browser journeys (`*.spec.ts`, `fixtures.ts`) and their configs (`playwright.config.ts`, `playwright.worker.config.ts`, whose web servers run in `dev/`), the Ledger Worker suite (`worker/`), `fixture-host/` (the site the tooling tests run in: placeholder shared infrastructure, `st` on the shared stack, and `solo` on its own stack), and `integration/st.tenant.json` (the development site with every module's features, swapped in by `pnpm test:integration`) |
| `examples/` | `empty` (the core only): committed `hearthlog init --workspace` output from `packages/tooling/templates/tenant/`; `pnpm check:examples` fails on drift, `pnpm examples:update` rewrites it; not a workspace member, and built from tarballs by `pnpm check:tarballs examples/empty` |
| `scripts/` | What only this repository needs: releasing (`release-version.ts`, `publish-packages.ts`; both run by the Release workflow, never by hand), the optional workspace coordinator (`release/release.mjs`, configured outside this repository; see `docs/releases.md`, test with `pnpm test:release`), package checks (`check-packages.ts`, `tarball-equivalence.ts` and `tarball-support.ts`), `integration.ts` (`pnpm test:integration`), and `layers.json` (the package graph `check:layers` enforces); the shared tools are in `packages/tooling` |
| `.github/workflows/` | `ci.yml` (checks, the integration run, browser journeys, the tarball build, the secret scan) and `release.yml` (run from the Actions tab with a version: it bumps every package, commits and tags `v<version>` on main, and publishes after approval in the `npm` environment). Nothing here deploys: a site deploys from its own repository |

The root `package.json` holds the repository's own scripts and the tools they run (TypeScript, tsx, Vitest, Playwright).
Site scripts (`dev`, `build`, `check:ts`, `test:unit`, `ledger:*`, `frontend:worker:*`, `check:modules`, `check:tenants`,
`hearthlog`, ...) are the development site's: run them as `pnpm -C dev <script>`.

## Commands

Prerequisites: Node.js 24 and pnpm 10.32.1 (pinned in `package.json`).

```bash
pnpm install            # setup
pnpm -C dev ledger:dev  # terminal 1: local Ledger Worker (port 8787)
pnpm -C dev dev         # terminal 2: SvelteKit dev server
```

### Verification before commit

Pick the checks that cover the change; when unsure, run `pnpm check:all`.

| Area changed | Commands |
| --- | --- |
| Frontend TS/Svelte | `pnpm -C dev check:ts` and `pnpm -C dev test:unit --run` |
| Packages, SDK, composer | above, plus `pnpm -C dev build:generated --check`, `pnpm -C dev check:modules`, `pnpm test:scripts` |
| Page/UI behavior | above, plus `pnpm -C dev build` and `pnpm test` |
| Frontend Worker gateway | `pnpm -C dev frontend:worker:typecheck` (+ `pnpm -C dev frontend:worker:dry-run` for binding/config changes; the `Env` drift check runs in `pnpm test:integration`) |
| Ledger | `pnpm -C dev ledger:check` and `pnpm -C dev ledger:test` (+ `pnpm -C dev ledger:dry-run` for config changes) |
| Scripts / tenant config | `pnpm check:scripts`, `pnpm test:scripts`, `pnpm -C dev check:tenants`, `pnpm check:examples`; `pnpm check:packages` after changing a package manifest or its `files` (packs each package and inspects the tarball); `pnpm check:tarballs` after changing what a package declares or exports (packs everything and builds a site outside the workspace, a few minutes); `pnpm -C dev hearthlog plan --site <id>` is read-only (`apply` changes Cloudflare: only when asked) |
| Native shell (`packages/native/`, `packages/runtime/src/native/`) | `pnpm -C dev apple:test`, `pnpm check:scripts`, and `pnpm -C dev apple:mac <site> --dev` run against `pnpm -C dev dev:e2e` |
| Cross-cutting / unsure | `pnpm check:all` |

Notes:

- CI (`.github/workflows/ci.yml`) runs, in the development site, `check:ts`,
  `check:modules`, `check:tenants`, `test:unit --run`,
  `frontend:worker:typecheck`, `build`, `frontend:worker:dry-run`,
  `ledger:check`, `ledger:test`, and `ledger:dry-run`, and at the root
  `check:examples`, `check:packages`, and `test:scripts`; then
  `test:integration`, the browser journeys (`pnpm test`),
  `check:tarballs examples/empty`, and a gitleaks scan, each in its own job.
  Match CI. `pnpm test:worker` (the Ledger Worker suite) is not in CI and
  currently fails four appends with 422.
- This repository installs no module, so the tests that need one are skipped
  here: in `pnpm -C dev test:unit` through `needModules` in `dev/vite.config.ts`,
  in `pnpm test:scripts` through a `needsModules` skip option on the test. Module
  feature ids are not in a catalog without modules, so tooling code and tests
  compare them as strings (`ids(...)` in the tests). `pnpm test:integration`
  installs the published `@hearthlog/module-*` into a throwaway project outside
  the repository (every package the development site installs is overridden
  with a link to its copy, the platform to `packages/*`), links them into
  `dev/modules/`, `dev/node_modules/@hearthlog/`, and `tests/fixture-host/modules/`,
  swaps in `tests/integration/st.tenant.json`, runs the unit and tooling tests,
  the type checks, the Worker `Env` check, and the Ledger checks, then removes the
  links and restores the site. It never writes a `package.json` or the lockfile:
  modules never go in either.
- The tooling tests (`pnpm test:scripts`) run in `tests/fixture-host/`, not the
  development site: give them what they need there.
- `pnpm test` is hermetic and needs no `pnpm -C dev ledger:dev`: `VITE_E2E=1`
  disables network sync and realtime, and the dev server stubs the Ledger
  contract. It is a handful of journeys that CI runs in one job.
- `pnpm -C dev check` (svelte-check) is currently incompatible with the TypeScript 7
  toolchain. Use `pnpm -C dev check:ts`; do not attempt to fix that upstream issue as a
  side quest.
- Never deploy or mutate remote state from an agent session unless the user
  explicitly asks: `deploy:*`, `ensure:tenant`, `wrangler deploy`,
  `wrangler secret put`. `ensure:tenant --rotate-token` revokes the only
  principal and drops live WebSockets.

## Architecture invariants

- **All writes go through commands/events.** Never mutate read-model tables
  directly, and never rewrite or delete existing event payloads or outbox
  bodies. Use `executeLocalCommand(events, { submissionId })` for multi-event
  actions: reuse the submission ID when retrying the same save, use a new one
  for a distinct action. Keep forms disabled while a save runs.
- **STRICT: filter and aggregate in SQLite, never in memory JavaScript.** All
  client-side filtering, sorting, searching, joining, grouping, counting, and
  aggregation must run as SQL against the read model through `queryDatabase`
  and scoped repositories — never by loading rows and processing them in
  JavaScript (components, stores, `$derived`, or helper functions). If the
  query you need does not exist, extend the repository; do not fetch a
  superset and narrow it client-side.
- **Generated files are off-limits and not committed.** `pnpm build:generated` writes everything the
  build generates, for one site (`VITE_STOR_TENANT`; unset, the host's only site, else `st`: `activeSiteId()` in
  `packages/tooling/src/root.ts`), into the gitignored `.generated/`: the
  module catalog, icons, repositories, entity types, schema, data APIs, and Ledger event schemas in
  `.generated/src/` (the package `@hearthlog/generated`), and the tenant module, boot shell, and gateway
  table in `.generated/sites/<id>/`. A site's modules are the ones in its `tenants/<id>/modules.lock.json`.
  Every command that reads them runs the build first (`dev`, `build`, `check:ts`, `test:unit`, `check:modules`,
  `check:tenants`, `ledger:*`, `frontend:worker:*`), which does nothing when its input hash (the site's files,
  the lock's manifests and entity definitions, the core entity definitions, the generators) is unchanged;
  `pnpm build:generated --check` fails when the outputs are stale. Edit
  `packages/contracts/src/event/entity-definitions.ts` or a module's `src/data/` and rebuild. Generated files
  are imported only through `#generated/*` (mapped in `package.json` `imports`; `check:modules` fails on a
  path import). `pnpm lock:modules` writes the catalog of every installed module first; the next command
  rebuilds the active site. Per-tenant module routes and the startup file in `src/routes/(modules)/` also come
  from the build.
- **Schema changes are migrations.** Bump `SCHEMA_VERSION` in
  `packages/runtime/src/db/schema-version.ts` when the materialized schema changes. A new
  column or changed meaning in a module's read model raises that module's
  `projectionVersion` instead: its tables are dropped, recreated, and refilled
  from raw events (never write an `ALTER TABLE` for a module table), and a
  database older than `MIN_IN_PLACE_SCHEMA_VERSION` gets the same treatment.
  Core tables and anything beyond a new standard table still need an explicit
  migration in `packages/runtime/src/db/index.ts`. Keep
  Durable Object/KV/R2/D1 migrations backward-compatible across the release
  window: remote state is not versioned and rollback must stay possible.
- **Deployment contracts.** `LedgerApp`/`AppRegistry` class names, bindings, and
  SQLite-backed Durable Object identities are tied to deployed data. Never
  rename them.
- **Tenant configuration.** A site is its directory `tenants/<id>/`: `tenant.json` (features, branding, authorized
  emails), `modules.lock.json` (`pnpm lock:modules`; regenerate it when a site's modules or a module manifest change),
  `static/` (its icons and brand files, served at the same paths; `pnpm generate:icons` writes them), and optionally
  `deployment.json`, which gives the site its own Ledger, buckets, and public Workers (a site deploys from its own
  repository; `pnpm tenant:export` writes one). `tenants.json` is optional and holds the shared stack's `infrastructure` and the `defaults` of
  the sites that use it. Never hand-write per-tenant wrangler config (`.generated/sites/<id>/wrangler.jsonc` is generated from the tenant files, the modules, and the base in
  `packages/tooling/src/tenants/wrangler-base.ts`). Run `pnpm check:tenants` after changes. Account values
  (`workersDevDomain`, Access team, admin email, renderer origin) are operator input in `tenants.json` or, for a site on
  its own stack, in its `deployment.json`; never constants in code.
- **Access control.** Route guards derive access from the active tenant's
  enabled features. Navigation visibility is not an access check; do not treat
  it as one.
- **Native shell.** The Mac and iOS apps load the deployed site; no domain logic lives in Swift. The
  page reaches the shell only through `packages/runtime/src/native/shell.ts`, which does nothing without
  `window.storShell`, and only small values cross it (counts, dates, titles, positions). Shell
  styling is scoped to `html[data-stor-shell]` in `packages/shell/src/styles/shell.css`, so the browser never matches it.
  Keep `NavigationPolicy` (`packages/native/swift/Shared/`) strict: the app's own origin loads, Access opens the
  sign-in window, everything else leaves the app. Generated files
  (`.apple-build/`) are never committed.
- **Secrets.** Never read, print, log, or commit `.env`, `.dev.vars`, or
  `.wrangler/` credential state. Use `.env.example` / `.dev.vars.example` to
  document variables. Worker secrets are write-only; they cannot be read back.
- **Offline semantics.** Preserve idempotent retries, the durable outbox, and
  entity-version conflict handling. Rejected events stay in raw history for
  diagnosis but are excluded from projections.

## Code conventions

- SvelteKit 3: project config (adapter, aliases, `compilerOptions`) is passed to
  the `sveltekit()` plugin in `vite.config.ts`; there is no `svelte.config.js`.
  The service worker is `packages/shell/src/service-worker/index.ts` (a Kit-bundled module; the host entry in `.generated/service-worker/` imports it, and `offline-bundle.ts` beside it holds the precache list). Kit's `files.routes`, `files.serviceWorker`, `files.assets`, and `files.appTemplate` point into `.generated/`.
- TypeScript strict (with `checkJs`); import platform code through its package with explicit extensions, for example `@hearthlog/runtime/utils/async.js` or `@hearthlog/ui/components/ui/Button.svelte`; the shell's own components are still imported with the `#lib` subpath import (`package.json` `imports`, for example `#lib/components/layout/NavBar.svelte`); SvelteKit 3 no longer provides `$lib`.
- 4-space indentation, single quotes, semicolons; match surrounding code. No
  formatter or linter is configured — do not add one unasked.
- Svelte 5 runes only: `$state`, `$derived`, `$effect`, `$props`, snippets.
  Never use Svelte 4 syntax (`export let`, `on:click`, `$:`), and never import
  runes.
- Reuse existing components, the feature registry
  (`packages/contracts/src/features/registry.ts`), and layout patterns. Do not add a parallel
  registry, transport, or design system.
- **New pages:** loads go through `deferPage` +
  `queryDatabase`, derive `routeData.pageResource` and pass it to
  `providePageResource`, render `PageDataStatus`, keep mutations inside
  `CommandOnly`, and register the refresh key in
  `packages/runtime/src/store/sync-invalidation.ts`.
- **New entities:** core entities go in `packages/contracts/src/event/entity-definitions.ts`, a module's in its
  `src/data/definitions.ts`; rebuild with `pnpm build:generated`. Persisted names (tables, events, fields) never change.
- **Date-sensitive pages:** use the active workspace clock where a shared
  date boundary matters.
- Prefer small, surgical diffs. Do not refactor, rename, or reformat code your
  task does not require, and do not introduce new dependencies without asking.

## Definition of done

A task is complete only when:

1. The change is implemented with existing patterns and contains no unrelated
   edits.
2. Targeted verification (above) passes; report the exact commands and results.
3. Tests stay few: a change to data integrity, access, or money rounding has a
   Vitest test, and a new core journey has a Playwright journey. Other
   behavior needs no new test (see Tests below).
4. Docs are updated when behavior, commands, or configuration change
   (`README.md`, `AGENTS.md`, `packages/ledger/README.md`).
5. The change is committed (see below).

## Commits

Commit your own work when a task is complete — do not leave finished changes
uncommitted, and do not ask for permission to commit.

- Use Conventional Commits matching repository history: `feat(scope): …`,
  `fix(scope): …`, `docs: …`, `test: …`, `refactor(scope): …`, `chore: …`.
- Lowercase, imperative subjects scoped to the area, for example
  `feat(invoices): split analytics into performance and obligations` or
  `fix(db): migrate invoice_parties for the merged_into column`.
- Stage only the files you changed. Never `git add -A` / `git add .` blindly;
  leave unrelated working-tree changes, build output (`build/`, `output/`,
  `.svelte-kit*/`), and local artifacts alone.
- Never commit secrets, `.env*` values, `.wrangler/` state, or `*.local` files.
- Never rewrite history (amend pushed commits, rebase, force push) or push
  unless the user explicitly asks.
- Finish by reporting: what changed, the verification commands run, and the
  commit hash.

## Common patterns

These are the repo-wide recipes most changes are built from. Copy the nearest
working example (Gallery, Calories, Invoices) instead of inventing a variant.

### Module layout

- Pure domain logic lives in a module's
  `src/` (for example `modules/health/src/calories/food-logic.ts`). It must not import Svelte,
  `$app/*`, runes, or stores.
- Feature UI lives in the owning module's `src/components/`; the shell's components live in
  `packages/shell/src/components/` (`layout/`, `history/`, `calendar/`,
  `data-table/`, `commands/`).
- Routes stay thin: `+page.ts` composes queries and `+page.svelte` composes
  components and command calls.
- Cross-cutting plumbing lives in `packages/runtime/src/runtime/` (page data, command
  availability, contextual clock), `packages/runtime/src/store/` (sync, outbox,
  notifications, logs), and `packages/runtime/src/db/` (schema, migrations, repositories).

### Page data: deferPage → PageResource

Loaders return immediately with an empty shape; data resolves through a
`PageResource` so the shell paints first and regions can stream in.

```ts
// src/routes/<page>/+page.ts
export const load = ((event) => {
    event.depends('app:gallery');
    return deferPage(event, { albums: [] as GalleryAlbum[] }, async () => ({
        albums: await queryDatabase((repositories) => repositories.records.galleryAlbum.list()),
    }));
}) satisfies PageLoad;
```

```svelte
<script lang="ts">
    let { data: routeData } = $props();
    const resource = $derived(routeData.pageResource);
    providePageResource(() => resource); // getter, not the value
    const data = $derived(resource.data);
</script>

<PageDataStatus {resource} />
```

- Always pass a getter to `providePageResource`.
- `resource.loading` / `resource.data`; `resource.isRegionLoading(id)` with
  `DataRegion` for widgets or slices that resolve independently;
  `resource.revision` re-runs effects after a refresh. The `deferPage` loader
  receives a `publish(update, region)` callback for streaming slices.
- `deferPage` is for read-model pages; `deferLocalPage` is for settings-only
  pages (`/calc`).
- Action-only query params must start with `new` (`newInvoice=1`,
  `newTransaction=1`): `deferPage` ignores them in the resource key so opening
  an editor never discards the loaded page or an open drawer.
- Register every `depends('app:…')` key in `SYNC_INVALIDATION_TARGETS`
  (`packages/runtime/src/store/sync-invalidation.ts`); a test compares loaders against it.

### Mutations: commands only

```ts
await executeLocalCommand(
    { id: crypto.randomUUID(), type: 'GALLERY_ALBUM_ADDED', timestamp: Date.now(), payload },
    { submissionId },
);
// generated single-entity adapter, same options:
await galleryAlbumCommands.create(payload, { submissionId });
```

- One event, or an array for a multi-event action. Reuse the `submissionId`
  when retrying the same save; use a new one for a distinct action.
- Never write projections or tables directly, and never edit stored event
  payloads or outbox bodies.
- Wrap mutation controls in `CommandOnly`; use `CommandDrawer`, `CommandModal`,
  or `CommandConfirmDialog` for mutation overlays so they close automatically
  when commands become unavailable. `CommandOnly` also disables its fieldset
  while the page resource is loading. Use `runCommandAction(action)`
  (`@hearthlog/ui/state/commands.js`) to guard programmatic actions.
- After success: `await refreshPageData('app:gallery')`
  (`@hearthlog/runtime/runtime/refresh.js`) plus `notify.success(...)`. Show failures inline
  with `role="alert"` or via `notify.error` — never swallow a failed save.

### Forms

- Draft fields are local `$state`; keep `busy` and `error` state; `onsubmit`
  prevents default and calls `void save()`.
- Disable submit and destructive row actions while `busy`, and keep the user's
  values when a save fails.
- Deep-linked creation follows the `?new…=1` convention: an effect opens the
  editor, then removes the one-shot param with `goto(url, { replace: true })`.
- Prefer `packages/ui/src/components/ui/` controls (`Field`, `Label`, `Input`,
  `Select`, `Textarea`, `Checkbox`, `DatePicker`, `DateTimePicker`, `Button`)
  over raw elements in new code.

### Reads: SQLite only

- `queryDatabase(async (repositories) => …)` is the page read entry point;
  repositories run against the active tenant and log read session.
- Filtering, sorting, pagination, joins, grouping, counting, and aggregation
  happen in SQL (Kysely or `sql` templates, for example
  `modules/invoices/src/data/invoice-list.ts`). Never fetch a superset and narrow it in JS.
- Tenant/log scoping is automatic: `session.selectFrom(table)` and
  `session.table(table)` apply the active session scope, so repositories never
  add `tenant_id` / `log_id` predicates by hand. Raw SQL references tables
  through `session.table(...)` and runs through `session.execute(...)`; a
  session does not expose the raw `db` client.
- Wrap long reads in `withTimeout` (`packages/runtime/src/utils/async.ts`).
- Keep shared row shapes and filter contracts in the owning module's `src/`
  (such as `list-contracts.ts`); extend a repository when a query is missing.

### URL as state

- Selection, filters, sort, page, tab, and open-pane state live in URL query
  params so reload and Back/Forward work. Parse and serialize in
  one module per feature (`modules/invoices/src/invoices/url.ts`) and manage only the params
  the route owns.
- Use `goto(url, { shallow: true, replace?, state })` from `$app/navigation`
  for in-page state (SvelteKit 3 deprecates `pushState` / `replaceState`).
- Existing `contextualHref(path)` calls (`@hearthlog/runtime/runtime/view.js`) return the path
  unchanged; new links can use ordinary local routes.

### Log history and forks

- `appClock.now()` / `appClock.ready()` provides the active workspace clock.
  It advances when the tab becomes visible and at local midnight; reads inside
  `$derived` or effects follow it, and loaders rerun when the date changes.
- The active-log control opens one side panel (`LogPanel`) titled with the
  log's name, its ancestors as a path, a **History | Logs** switch and **Copy
  this log**. History shows a minimap (`LogMap`) above the list: log lines on a time axis, the current log's actions as points with hover labels, click to open, drag or wheel to scroll the list.
  The list marks where the log starts (copied actions below that card read
  lighter) and where other logs branched off; those positions come from SQL.
  Tree, markers and map geometry are pure functions in `packages/runtime/src/history/` (`lineage.ts`, `log-map.ts`), built
  from Ledger's lineage index. Do not add a full-page history workspace or a
  persistent History shortcut to the main navigation.
- A row opens in place; **New log after this** and **Copy this log** move the
  name and **Create and switch** into the panel footer (`ForkComposer`). There
  is no "before this" choice. Hiding a log only sets Ledger's `hidden_at`.
- Forking creates a separate log from a complete accepted action and switches
  the current device when inherited private files are ready. Preserve legacy
  replay of already accepted restore and removal directives, but do not add
  new client commands for them. Old `asOfVersion` links redirect to Log history.

### Reactive state

- `.svelte.ts` stores export plain objects or classes holding `$state` /
  `$derived` (for example `notifications.svelte.ts`); components use runes
  directly. Side effects belong in `$effect` with teardown, cross-component
  state belongs in a store, not context.
- Long-lived singletons that must survive HMR cache themselves on `globalThis`
  (see `runtime/view.ts`).

### Feature gating

- Register a feature and page in `packages/contracts/src/features/registry.ts`, its icon in
  `packages/shell/src/components/layout/feature-icons.ts`, and gate data/UI with
  `isFeatureEnabled(id)`. Access comes from `tenant.features` in the root load;
  navigation visibility is not an access check.
- There is no Today overview page; `/today` only redirects to the start
  section. Do not reintroduce it or an equivalent dashboard.

### Tests

- Vitest covers only what protects data, access, and money: commands,
  projections, migrations, tenant/log scoping, outbox and sync, history
  replay, Access and gateway auth, and money rounding (colocated
  `*.test.ts`). Feature logic, formatting, and UI helpers get no unit test.
- Playwright is a few core journeys, one per feature at most
  (`tests/<feature>.spec.ts`). Extend an existing journey before adding one,
  and never add a browser test for layout, viewport widths, or copy. The
  default `pnpm test` run is hermetic (no Ledger) and excludes
  `tests/worker/`, which uses its own config (`playwright.worker.config.ts`,
  `pnpm test:worker`). Extend
  `tests/fixtures.ts` instead of re-seeding per spec.

## Design system

### Tokens

All colors and shadows are `--stor-*` CSS variables generated per tenant
(`packages/tooling/src/generate/generate-tenant.ts` → `.generated/sites/<id>/app.html`, from `packages/shell/src/app.template.html`) and consumed through Tailwind
arbitrary values, for example `text-[var(--stor-muted-text)]`.

A tenant sets one value, `theme.accent`; `themePaletteFor()` in `packages/contracts/src/tenant/theme.ts` derives
the rest. Neutrals, status, ember, and the Health domains are fixed warm values shared by every site (the accent
never tints a surface, so a tinted surface always means selection); only the accent's roles are derived, in OKLCH:

- Light action: the accent when it clears 4.5:1 on `--stor-surface` (chroma capped at 0.17), else the same hue at
  a lower lightness. Dark action: the same hue at L 0.78, chroma at least 0.09, with text in the canvas colour.
  Soft: L 0.94, chroma ≤ 0.04 (light); L 0.30, chroma ≤ 0.05 (dark). An accent with chroma under 0.02 makes a
  monochrome site: the action is ink and soft is the well tone.
- Clashes (OKLab ΔE < 0.10 with the action): a status colour turns its hue only inside its family (negative
  15–35°, warning 55–90°, positive 135–165°, info 225–255°), to the end farther from the accent; ember too close
  draws `--stor-now` in ink. `hearthlog build` prints the site's palette and every clash it resolved, and
  `theme.test.ts` sweeps 144 accents in both modes for text ≥ 4.5:1, focus ≥ 3:1, and a rule for every clash.

| Role | Tokens |
| --- | --- |
| Canvas / surfaces | `--stor-bg`, `--stor-sidebar`, `--stor-surface`, `--stor-surface-muted`, `--stor-surface-raised`, `--stor-surface-hover` |
| Text | `--stor-ink` (primary), `--stor-muted-text` (secondary), `--stor-faint-text` (placeholders and disabled text only; below 4.5:1) |
| Brand / action | `--stor-accent` (the derived action colour for marks: dots, rings, progress; never the raw input), `--stor-accent-text` and `--stor-accent-strong` (links and selected labels, ≥ 4.5:1 on every surface), `--stor-accent-soft`; buttons use `--stor-action`, `--stor-action-text`, `--stor-action-hover`; `--stor-action-inverse` is the action as the other mode draws it, for Undo on the inverse pill (≥ 4.5:1 on `--stor-tooltip`) |
| Lines / focus | `--stor-border` (hairlines), `--stor-border-strong` (rules that must show), `--stor-field-border`, `--stor-selected`, `--stor-focus`, `--stor-overlay` |
| Now | `--stor-now`, `--stor-now-soft`: ember, for today and now marks only, never text |
| Status | `--stor-positive`, `--stor-negative`, `--stor-warning`, `--stor-info` (+ `-soft`, `--stor-info-border`) |
| Charts / code | `--stor-chart-*` (curated families chosen by accent hue), `--stor-code-*` |
| Health domains | `--stor-health-eat`, `--stor-health-move`, `--stor-health-body` (fixed, the same on every site); `.stor-tone-eat/-move/-body` set `--tone` from them, and tints are `color-mix(in srgb, var(--tone) N%, var(--stor-surface))` |
| Elevation | `--stor-surface-well/-overlay/-sheet`, `--stor-well-shadow` (flat: `none`), `--stor-elevation-1…4`, `--stor-elevation-pressed`, `--stor-nav-card-shadow`, `--stor-tooltip`; `--stor-shadow-sm/md/lg`, `--stor-panel-shadow`, `--stor-sidebar-shadow` are aliases; `--stor-header-shadow` |

**Depth.** Every surface sits on one level of a z scale, lit from above. A component picks a level, never its
own shadow: well (`.stor-well`: tab and segmented tracks, checkboxes; a flat tone, no inset shadow),
canvas (`--stor-bg`, which the sidebar sits on), panel (`.stor-panel`, the page panel, dock; `--stor-elevation-1`,
a hairline and a 4% shadow), raised (`.stor-raised`, the selected pill; level 2, a hairline and
a 6% shadow), menu (`.stor-menu`: Select, dropdowns, popovers, date picker; level 3), sheet (`.stor-sheet`: Drawer,
Modal, ConfirmDialog; level 4); only menus and sheets cast a deep shadow. Shadows are warm ink, rgb(34 29 24), with
no inset rims, and buttons cast none: primary is a flat fill, secondary the raised surface with a 1px border. Dark mode shows height as lighter surfaces: page
and raised are the hairline alone, menus and sheets add black. The sidebar's current section is a raised card that
holds its sub-pages (`[data-nav-section][data-active]` and the sliding `.stor-nav-indicator`); it keeps a step more
lift than raised (`--stor-nav-card-shadow`), so keep that structure. From 768px `[data-stor-main]` is the page panel: inside it `--stor-bg` is the
panel's surface and `.stor-panel` sections are outlined rather than shadowed (`shell.css`). Strength is the single `ELEVATION_STRENGTH` constant in
`packages/contracts/src/tenant/theme.ts`. Stack with the `--stor-layer-*` tokens
(`z-[var(--stor-layer-menu)]`), not literal z-index numbers, and do not use raw
Tailwind `shadow-sm/md/lg/xl`.

Layout, type, and motion tokens live in `packages/ui/src/styles/base.css` `:root`:
`--stor-section-gap`, `--stor-panel-padding`, `--stor-panel-radius`,
`--stor-mobile-*` (header/nav/action geometry, safe-area aware),
`--stor-sidebar-width`, the type scale `--stor-text-*` (below), and motion: four durations
`--stor-dur-1…4` (90 ms press and hover, 160 ms fades and every exit, 240 ms the selection pill, popovers and
changing figures, 320 ms sheets and time) and two curves, `--stor-ease-out` (everything that enters) and
`--stor-ease-in` (everything that leaves). `--stor-drawer-*` (enter/exit motion) and `--stor-tab-motion` (the
sliding tab pill) are built from them; reduced motion zeroes them. Use the tokens rather than literal durations.

- Use tokens for anything that must follow theme or tenant. Literal palette
  classes (`bg-white`, `text-stone-900`, …) survive only through the
  transitional dark-mode remap in `packages/ui/src/styles/base.css`; do not add new consumers of
  it, and do not add `dark:` variants for ordinary color changes — tokens flip
  through `html[data-theme]`.

### Layout and typography

- Mobile-first. `md` (768px) is where the shell becomes the rail and the phone
  header and dock go away; `lg` (1024px) is where pages take their desktop
  layouts and the expanded sidebar becomes available (it opens by default from
  1280px); `2xl` is pushed to 1920px so multi-column layouts only appear on very
  wide screens.
- Page pattern: `.stor-page` wrapper with `p-2.5 sm:p-3`, `PageHeader`, then
  `.stor-panel` sections separated by `--stor-section-gap`. A panel owns its
  surface, radius, and shadow; its header/body own padding. Do not nest cards
  for ordinary content.
- Controls are 44px tall on touch (`h-11`) and compact 36px with a mouse from 640px (`fine:h-9`, the
  `fine` variant is 640px and a fine pointer; width alone is not a finger); the page panel and sheets use `--stor-panel-radius` (20px, 16px on phones), sections inside it
  (`.stor-panel`) `--stor-section-radius` (16px), controls `rounded-xl` on phones and 10px from `sm:`
  (Button and the field recipe do this), badges 6px, small tiles `rounded-lg`, pills and tabs `rounded-full`
  (`md` and `2xl` fold into this set). Panel padding is 16px on phones, 20px from `sm`,
  24px from `lg`; section gaps are 12px on phones; page gutters are
  `p-2.5 sm:p-3`.
- Format numbers with `@hearthlog/ui/utils/number-format.js` (`formatMoney`,
  `formatAmount`, `formatNumber`) and `Amount` for large money figures; do not
  create local `Intl.NumberFormat` instances. Negative amounts stay in ink. Read typed amounts with
  `parseAmount` (Czech or plain decimals and simple sums such as `1200+84`, exact to the haléř), as
  `AmountField` does.
- Type: Inter Variable (`--stor-font-sans`), Fira Code (`--stor-font-mono`, developer pages, JSON, and IDs),
  and Newsreader Variable (`--stor-font-serif`, self-hosted like Inter with `font-display: optional`, the system
  serif as fallback; via `.stor-serif-title`, `.stor-title-1/-2`, or `font-serif`) for page, month, day, and
  overlay titles only. Eight sizes, as `--stor-text-<name>` / `-line` variables and Tailwind `text-<name>` sizes
  that carry their line height, tracking, and weight: `display` 40/44 (hero figures), `title-1` 30/36 serif (26/32
  below 640px), `title-2` 22/28 serif, `title-3` 16/24, `body` 14/22, `small` 13/18, `caption` 12/16, `overline`
  11/16 (uppercase +0.06em: `.stor-overline`). Body is 14px with tabular numbers, `--stor-muted-text` for
  secondary copy. Prefer these sizes to new ad-hoc ones; existing `text-2xl`/28px page titles and 28–32px metrics
  move onto them component by component.
- Icons come from `~icons/mdi/*` (unplugin): `h-4 w-4` inline, `h-5 w-5` in
  headers and empty states.

### Shared `.stor-*` recipes

The design system's own (panel, page, metric, menu, sheet, tabs, drawer, buttons, fonts, tokens) are in
`packages/ui/src/styles/` (`base.css`, `recipes.css`), imported once by the generated `.generated/app.css`; the shell's recipes are in
`packages/shell/src/styles/shell.css`, and a module's own recipes are in its `src/styles.css` (manifest `styles`),
imported through `.generated/module-sources.generated.css` only for tenants that enable the module.

- Shell: `.stor-mobile-header`, `.stor-mobile-nav`, `.stor-mobile-action`,
  `.stor-drawer*`, `.stor-notifications`.
- Page structure: `.stor-page`, `.stor-page-header`, `.stor-toolbar`,
  `.stor-page-tabs` / `.stor-page-tab` (one capsule track with a raised
  selected pill that slides between triggers; `.stor-primary-tabs` is the
  page-level size, `.stor-section-tabs` the compact in-panel size),
  `.stor-segmented-control` / `.stor-segmented-option`.
- Health: `.stor-tone-eat`, `.stor-tone-move`, `.stor-tone-body` give a domain
  its colour on every Health page; `HealthDaysShell` (tabs, the Monday-to-Sunday
  strip `HealthDayHeader`, the one-day-at-a-time `HealthDaysList` on
  `DayPager`, and the week panels beside it), `HealthDayTitle` (a day's serif date), `HealthHead` (title
  and primary action), `HealthRow`, `HealthRing`, `HealthBudgetBar`, and
  `WeekBars` are the shared pieces.
- Content: `.stor-panel`, `.stor-panel-header` (with `.stor-panel-title`, title-3; it sits over a hairline when a
  `.stor-panel-body` follows it, or with `.stor-panel-header-rule`), `.stor-panel-body`, `.stor-metric*` (a figure:
  overline label, value, support line in small), `.stor-unit` (0.55em after a figure), `.stor-today-card`,
  `.stor-section-link`.
- Controls: `.stor-field-control` (the field recipe: muted fill in the 3:1 outline; focus lifts it to the surface
  with a `--stor-focus` border and a 3px `--stor-accent-soft` halo instead of the global outline; `aria-invalid` or
  a surrounding `[data-stor-invalid]`, which `Field` sets with its error, turns it negative) and `.stor-kbd` (a
  key cap; hidden on touch screens, like every key hint).
- Reuse these before adding global CSS; complex one-off geometry belongs in the
  owning component's scoped `<style>`.

### Components

- Primitives in `packages/ui/src/components/ui/`: `Button` (`default | secondary |
  ghost | destructive`; `sm | md | icon`; `busy` keeps its width and shows a spinner, `shortcut` draws a key
  cap; primary is the flat accent fill, secondary a raised surface with a 1px border, ghost hovers on the neutral
  hover surface, destructive is tonal), `Badge` (`default | success | warning | danger | info`; caption text and a
  6px status dot, always with a word), `Input`, `Select`, `Textarea`, `Checkbox`, `Label` (caption, muted),
  `Field` (label above, help or `role="alert"` error below), `AmountField` (a money amount at display size with
  its currency and an Expense/Income toggle inside; `value` is the unsigned amount, `direction` is bindable, simple
  sums resolve on blur or Enter), `Metric` (`unit`, and `delta` / `sparkline` snippets), date/time pickers, and
  `Tooltip` (Bits UI underneath). Compose classes with `cn()` (it knows the `text-<name>` type sizes) and use
  `class` for placement only.
- Overlays: `Drawer` (right-hand sheet; full-width on mobile, floating 28rem /
  36rem at `lg`), `Modal` (bottom sheet on mobile, centered dialog on `sm:`; optional `footer`),
  `ConfirmDialog` (Bits UI AlertDialog; Cancel is autofocused; tone `danger` or
  `primary`; the one place a destructive action is a red fill). All three have title-2 serif titles and a footer
  below the scrolling body with the primary action last (on the right); ⌘↵ (Ctrl+Enter elsewhere) presses the
  footer's last primary-variant button, which shows the hint, and Esc is hinted beside the close button
  (`overlay-keys.ts`). Use the `Command*` wrappers for mutation overlays.
- Data surfaces: `DataTable` (TanStack Table, `variant="quiet"` inside panels)
  with SQL-backed manual pagination/sorting, `EndlessList` (TanStack Virtual)
  for endless date blocks read from SQL as they scroll into view (Finance
  months, Calendar weeks, Gallery months), `DayPager` for Health days one at a
  time, `EmptyState`,
  `DataPlaceholder`, `DataValue`, `DataRegion`, `PageDataStatus`,
  `NotificationCenter`.

### UX conventions

- Page skeleton: `<svelte:head><title>… | {tenant.title}</title></svelte:head>`,
  `PageHeader` (one `h1`, actions, context/tabs), `PageDataStatus`, then
  content sections. Section pages hide the title visually (mobile label only,
  `showTitle` off) because navigation names the place; detail pages that name
  their subject pass `showTitle`. `PageHeader` has no description prop.
- Loading: `PageDataStatus` at page level, `DataRegion` + `DataPlaceholder` per
  region, `DataValue` for single values, table skeletons for lists. All
  skeletons pair `role="status"` with `motion-safe:animate-pulse`.
- Empty: `EmptyState` (a domain `illustration` snippet or an icon, a serif title, one sentence, then the
  primary action and an optional secondary one) for a whole panel or table; a short muted sentence for inline
  lists.
- Errors: blocking page errors render in `PageDataStatus` with a Retry
  (`invalidateAll`); form errors are inline `role="alert"` text; background
  failures use `notify.error`.
- Notifications (toasts are `.stor-toast`, inverse ink pills): `notify.success | info | error(message, action?)`;
  `notify.progress` returns an id for sticky tasks and is dismissed with
  `dismissNotification`. Prefer an action button (for example Undo) over a
  second confirmation when the domain supports reversal.
- Keyboard (`shortcuts.ts`, installed by the layout): N presses the page's visible `data-stor-new` button (give the page's primary create button `data-stor-new shortcut="N"`), else opens the feature's first create shortcut (`commands[0]`), ← / → and T step and reset the page's time navigator (`MonthNavigator` registers itself in `state/time-navigation.ts`; a new navigator should do the same), G then F, H, C or I goes to Finance, Health, Calendar or Invoices (matched by nav label), ⌘Z undoes the last change, ⌘↵ and Esc belong to sheets. Nothing fires while typing, inside a grid, list or menu, or while a sheet is open. A shortcut always has a visible control too.
- Time travel: a month or day change that goes through `timeTravel(direction, update)` (`@hearthlog/ui/utils/time-travel.js`, used by `MonthNavigator`) slides the page panel's content 16px against the direction of time while it cross-fades (View Transitions; none under reduced motion or without the API). Day-level navigation in module pages can call it the same way.
- Destructive actions confirm through `ConfirmDialog`, disable themselves
  while running, and offer undo where one exists.
- Phones (below 768 px): one top bar
  (section, sub-page menu, the page's one figure via `PhoneGlance`, the log),
  every other figure in that figure's sheet, filters behind one options
  button, no row checkboxes until press and hold, required fields first.
  Desktop and tablet layouts stay as they are.
- Sidebar figures: from 1024px each section and sub-page may carry one live figure beside its
  name (`AttentionContribution.figures` in the module's `attention` file, read with SQL like badges;
  the calendar's own is the next pinned date). Keep it short and muted, leave it out rather than show
  a zero; a late-work badge takes its place, and the rail shows it only in the tooltip.
- Recently: the expanded sidebar lists up to four places this device opened in the current log,
  outside the section in view (`recent-places.svelte.ts`, browser storage, never synced). A place
  is named by the first part of the page's `<title>`, so give a month, sub-page, or record its own
  title; a page titled only with its section name is not listed.
- Last change: from 768px the shell shows an inverse ink pill (`.stor-last-change`, the toast face: `--stor-tooltip` fill, `--stor-tooltip-text`, Undo in `--stor-action-inverse`) for the latest change this tab committed,
  named as Log history names it, with History and, when the action only added standard records, Undo
  (`LastChangeBar`). Undo appends those records' `…_REMOVED` events (`runtime/commands/undo.ts`);
  it never tombstones or edits events. Edits, removals and module-specific events offer no undo.
- Mobile: bottom navigation shows the primary destinations, `MobilePageAction`
  renders the page's main action as a label-sized pill at the bottom right above
  it (hidden while a drawer is open), and `[data-stor-main]` owns bottom
  clearance. One surface scrolls per phone screen: Finance's list scrolls inside
  a page that fits, and Health's page scrolls the day under a sticky week strip
  (`DayPager` `flow` below `lg`). From 768px the collapsed
  rail replaces the bottom navigation and `--stor-mobile-header-height` and
  `--stor-mobile-nav-height` fall to zero, so size fixed elements from those
  variables and keep them clear of the rail (`md:left-[116px]`). Fixed elements
  respect `env(safe-area-inset-*)`.
- Log history: show the source log, accepted action, and fork point clearly;
  keep the original log available in the switcher.
- High contrast: `prefers-contrast: more` swaps hairlines for `--stor-border-strong` and muted and faint text for ink (`base.css`); `forced-colors: active` keeps borders on sections, menus and sheets and an outline on selected pills.
- Accessibility: focus-visible rings via `--stor-focus`, `aria-label` on
  icon-only controls, `aria-pressed` / `aria-current` / `data-state` on tabs and
  segmented controls, `aria-live`/`role="status"` for status regions, 44px
  targets on touch, and reduced-motion handled globally.
- Copy is short, sentence case, English; shared formatters live in
  the owning module's `src/` (`format.ts`) and use `date-fns` / `Intl` rather than ad-hoc
  formatting. Keep to the copy budget: label, value,
  and at most one support line per panel — no restated labels or glosses.
