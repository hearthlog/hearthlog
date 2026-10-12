# Modules

A module is a feature packaged on its own: its pages, components, and domain
code live in `modules/<name>/`, and it reaches the app only through the
platform API. Calc (pages only), Health (pages, entities, repositories, and the
step integration), Finance (pages with a layout and parameterized routes,
entities, repositories, calendar icons, and an AI capability), Invoices (pages, entities,
repositories, startup coordinators, navigation badges and reminders, gateway routes,
the renderer proxy and AI extraction, an AI capability, and fork files), and Gallery (pages,
entities, gateway routes, bindings, a daily job, a startup coordinator, and its
own public Worker) are modules; Calendar is part of the core. The plan for the
rest is in
the modular platform plan.

## Layout

```text
modules/calc/
  package.json        # @hearthlog/module-calc; exports its pages; declares third-party packages
  hearthlog.module.json    # the manifest: features, routes, sub-pages, refresh keys
  src/
    pages/            # routed page components and their loaders
    components/
    data/             # definitions.ts (entities), repositories.ts, read queries
    *.ts              # domain code
```

`hearthlog.module.json` is plain data (`@hearthlog/contracts` documents and validates
it). A feature declares its id (persisted in `tenants.json`; never rename it),
path, label, subtitle, keywords, navigation group, `navOrder` (its place among
the destinations; none comes last), `mdi` icon name, and its sidebar children
(a child's `badgeId` ties it to an attention badge) and shortcuts. Each route names a page and an optional loader
under `src/pages/`, and may say it fits the screen (`fitsScreen`) or needs some
of the module's features (`requires`, such as Health's Day view needing two).
A route path may hold `[param]` segments (`/finance/[year]/[month]`).
Optional parts:

- `layouts` wrap routes under a path with a layout component and an optional
  loader (Finance loads its assets once for every Finance page). A route may set
  `keepMounted` (the page stays mounted when only its parameters change) and
  `resolvesTo` (an index route that redirects, so navigation timing skips it).
- `attention` is a browser file exporting an `AttentionContribution`: `badges`
  (navigation badges, shown on the navigation ids each badge names; a child's
  `badgeId` in the manifest ties a sub-page to one) and `reminders` (native
  notifications). Both read SQL through `queryDatabase`. Invoices badges overdue
  invoices and reminds before they fall due; Finance reminds of the day's plans.
  The composer lists the enabled modules' contributions in
  `.generated/routes/(modules)/startup.ts`, and the root layout passes them to the
  attention store.
- `localStores` names the browser databases a module keeps files in (Invoices'
  PDFs and originals); the storage statistics list them.
- `calendarIcons` names the `mdi` icons the module's calendar sources use; the
  core calendar looks them up by name.
- `aiCapabilities` lists the AI decision capabilities the module defines in its
  server entry (`ServerModule.ai`: the options, how to read a model answer, and the
  question). Finance contributes `category-pick`; the core keeps the host
  (`packages/cloudflare/src/ai-decisions.ts`) and the browser client.

- `section` groups several features into one navigation destination (Health:
  Day, Body, Nutrition, Activity, Food library). It opens on the first place the
  tenant can see; the module reads the same list with `sectionLinks` from
  `@hearthlog/sdk/runtime`.
- `redirects` move old addresses before the feature guard runs.
- `data.definitions` exports `ENTITY_DEFINITIONS` (typed with
  `@hearthlog/sdk/entities`, which is Node-safe). These are deployed data contracts:
  moving them into a module never renames a table, event, or field. An entity that points at an
  immutable file stored outside the Ledger declares `fileReference: { versionField }`; the
  generated Ledger contracts then record, per log, every accepted version it names, and a private
  file gateway can ask whether a log may read one (Gallery's photos).
- `data.repositories` exports `createRepositories(session)`; its repositories
  join `queryDatabase` beside the core's.
- `projectionVersion` raises when the module's read-model tables or their meaning
  change. The local database records each module's version in `module_migrations`
  (tables that predate the ledger are at the baseline, 1); a load that finds a
  different version drops and recreates the module's tables and refills them
  from raw events, so a new column never needs an `ALTER TABLE`. Other logs on
  the device refill when they are next opened. It never rewrites events or touches the outbox.
- `startup` is a browser file exporting `start()`; the layout runs it for tenants
  that enable the module (Gallery's background upload coordinator). It may return
  a function that stops it.
- `styles` is a stylesheet (`./src/styles.css`, exported by the package as `./styles.css`) with the
  module's own `.stor-*` recipes. `pnpm compose` lists it in `.generated/module-sources.generated.css`, which
  `.generated/app.css` imports after the design system and the shell, so only tenants that enable the module
  get its CSS. Health, Finance, and Invoices use it.
- `integrationKinds` declares service integrations the module implements
  (Health: `steps`, needing `activities`); `tenants.json` validates against them.
- `server` adds to the gateway Worker, see below.
- `publicWorker` names an anonymous Worker in the module's `public/` directory
  (Gallery's published pages), deployed beside the gateway.

## Gateway code

`server.entry` (a file in `src/server/`) default-exports a `ServerModule`:
`routes` (a prefix and a handler each; list the longer prefix first when one
sits beneath another), `scheduled` (a daily job), `ai` (decision capabilities),
`integrations` (handlers by kind), and `forkFiles` (see below). The generated
`run_worker_first` list leaves out a prefix a shorter one already covers, because
Wrangler rejects redundant rules. The manifest declares the same
prefixes, the logical bindings (`r2` buckets by infrastructure key, `images`) and
variables the code needs. The host keeps Access auth, the Ledger proxy, the user
session, and administration.

- Each site's gateway bundles only the server code of the modules it enables.
  `pnpm build:generated` writes the site's table, `.generated/sites/<id>/server-modules.ts`,
  and the gateway entry `.generated/sites/<id>/worker.ts` that imports it (neither is committed);
  each site's Wrangler config names that entry as `main`. `pnpm check:tenants` checks
  that bindings, variables, `main`, and `run_worker_first` follow the modules.
- Bindings, variables, `run_worker_first` entries, the bucket list `ensure:tenant`
  creates, and the daily trigger (only the top-level site and sites on their own
  stack run one) come from the manifests, so a site without Gallery has no
  Gallery buckets, no `IMAGES` binding, and no Gallery Worker code.
- Worker code in `src/server/` may import only the SDK's Worker-safe entries
  (`@hearthlog/sdk/server`, `entities`, `axis`, `format`); `check:modules`
  enforces it.

### Fork files

A fork copies the files its inherited events reference. The host asks every
module's `forkFiles` (`packages/cloudflare/src/file-lifecycle.ts`; Invoices contributes its issued
and received originals),
merges the answers, copies them, and cannot finish while a required file is
missing. A module whose files are keyed by app rather than log has nothing to
copy: Gallery's originals are `v1/<appId>/…`, and every log of the app already
sees them. Gallery therefore contributes none (its events do not say whether an
upload finished, so a "required" check would block forks for photos still
queued on a device).

## What a module may import

- `@hearthlog/sdk/runtime` (page lifecycle, refresh, commands availability, notifications, the workspace clock, tenant identity, device settings, sections), `@hearthlog/sdk/data` (`queryDatabase`, `executeLocalCommand`, generated entity and event types), `@hearthlog/sdk/entities`, `@hearthlog/sdk/ui` (design system and command overlays), `@hearthlog/sdk/endless` (endless lists, `DayPager`), `@hearthlog/sdk/table`, `@hearthlog/sdk/format`, and in tests `@hearthlog/sdk/testing`.
- `svelte`, `$app/*`, `~icons/*`, the packages its `package.json` declares, and its own files.

Never `#lib`, a relative path out of the module, or another module.
`pnpm check:modules` enforces this, and also that the app imports a module only
through generated files. It also type-checks every named import from `@hearthlog/sdk/*`
in module `.svelte` files (`packages/tooling/src/check/check-sdk-exports.ts`), because `tsc` does not
read Svelte files and a missing SDK export would otherwise surface only in a build. When a module needs something the SDK lacks, add a
re-export to `packages/sdk/src/` rather than importing the app.

A loader cannot use the app's generated `./$types`; type its argument with
`ModuleLoadEvent` from `@hearthlog/sdk/runtime` (or structurally, `({ url }: { url: URL })`).

## How it reaches the app

- `pnpm build:generated` writes the catalog of the site's modules (those in its `modules.lock.json`): `.generated/src/modules.generated.ts` (features, sections, routes, redirects, entity definitions, refresh keys), `.generated/src/module-icons.generated.ts`, and the browser-only `.generated/src/module-repositories.generated.ts`. The registry, navigation, route guard, entity registry, and `queryDatabase` read them. They are gitignored; every command that reads them runs the build first, and `pnpm build:generated --check` fails when they are stale. After changing a module's entity definitions, also run `pnpm generate:entities`.
- `pnpm compose` writes thin route wrappers into the gitignored `.generated/routes/(modules)/` for the modules whose features the tenant (`VITE_STOR_TENANT`, default `st`) enables. `pnpm build:generated` runs it (and `dev`, `dev:e2e`, `build`, and `check:ts` run that), so a tenant without a module ships none of its pages.
- It also writes `.generated/module-sources.generated.css` (gitignored), the `@source` list that makes Tailwind scan the enabled modules' `src/`; Tailwind otherwise scans only the generated host, and a class used only in a module silently loses its style (Finance's timeline collapsed and the virtualizer rendered every month).
- Vite's dev server serves `modules/` and `packages/` through `server.fs.allow` in `vite.config.ts`; without it a lazily imported module file answers 403.
- The composer rejects a module whose feature id, route, or refresh key is already the core's or another module's.

Route access still comes from the tenant's features, as for core pages.

## Creating and exporting a module

```bash
pnpm module:new -- notes --feature notes   # a working module in modules/notes/
pnpm install && pnpm lock:modules
# list "notes" in a site's features, then: pnpm lock:modules && pnpm build:generated
pnpm module:export -- notes --out ../hearthlog-module-notes
```

`module:new` writes a minimal module (one feature, one page, `@hearthlog/sdk` only). It composes
without any edit to the core: the composer finds it by its directory and rejects a
feature, route, or refresh key another module already holds. `module:export` lays a module
out as a repository of its own: files at the root, `@hearthlog/*` references turned into peer
ranges (and dev dependencies, so it is tested against the platform it accepts), the AGPL license, a `files` list
that leaves the tests out, provenance publishing, and two workflows. A platform package the sources import must be
declared in the module's `package.json` (the export refuses otherwise). `pnpm test` in the exported repository is
`hearthlog check-module`: it generates a throwaway site that enables the module, installs it against the platform range,
builds it, then runs the module's unit tests against that site's generated files (`--overrides <file.json>` points platform
packages at local tarballs; `pnpm check:modules-standalone` in the platform repository does this for every module). CI
runs that and a secret scan; pushing the tag `v<version>` runs the release workflow, which publishes with provenance in
the protected `npm` environment after approval. The module's journeys stay in the platform repository until a
fixture-host command exists.
