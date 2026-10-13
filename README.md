# Hearthlog

Hearthlog is an offline-first platform for personal and household data. The app runs in the
browser and keeps working without a network. It synchronizes through an event store that you
deploy to your own Cloudflare account.

This repository is the core: the shell, the offline runtime, the Ledger event store, the gateway
Worker, the SDK that modules build on, and the tooling that composes and deploys a site. Features
such as finance, invoices, and photos are modules, published as their own packages.

## What it does

- **Offline first.** The browser keeps the full event history and the read models in SQLite
  (WebAssembly, in the browser's private file system). Every page works offline, and changes wait
  in a durable outbox until the network returns.
- **Event sourced.** Commands validate and append immutable events, and projections turn them into
  queryable tables. Nothing is edited in place, so history, authorship, and forks of a log are
  always available.
- **Modular.** A module adds pages, entities, repositories, and optional gateway code, and
  declares them in a manifest (`hearthlog.module.json`). The core knows nothing about invoices or
  photos.
- **Yours.** A site is one deployment with its own Ledger, buckets, and Cloudflare Access rules.
  Credentials stay on the server side and are never shipped to the browser.

## How it fits together

```text
Browser (SvelteKit)
  ├─ OPFS SQLite: raw events, outbox, projections
  └─ /api/ledger
       └─ Gateway Worker (@hearthlog/cloudflare): Access sessions, same-origin proxy
            └─ LEDGER service binding
                 └─ Ledger Worker (@hearthlog/ledger)
                      ├─ AppRegistry Durable Object
                      └─ LedgerApp Durable Objects
```

HTTP is authoritative for append, replay, and recovery. WebSockets only deliver ordered live
batches. The Ledger protocol is specified in
[`packages/ledger/docs/`](packages/ledger/docs/), and [`packages/ledger/README.md`](packages/ledger/README.md)
covers its event policy and backups.

## Repositories

| Repository | Holds |
| --- | --- |
| [`hearthlog`](https://github.com/hearthlog/hearthlog) (this one) | The platform packages `@hearthlog/*` |
| [`hearthlog-module-calc`](https://github.com/hearthlog/hearthlog-module-calc) | Small calculators |
| [`hearthlog-module-finance`](https://github.com/hearthlog/hearthlog-module-finance) | Assets, a month-by-month transaction timeline, budgets, and plans |
| [`hearthlog-module-invoices`](https://github.com/hearthlog/hearthlog-module-invoices) | Issued and received invoices, PDF generation, and AI-assisted extraction |
| [`hearthlog-module-gallery`](https://github.com/hearthlog/hearthlog-module-gallery) | A private photo library with albums and an explicit public export |
| [`hearthlog-module-health`](https://github.com/hearthlog/hearthlog-module-health) | Nutrition, activity, body measurements, and a day view across them |
| One private repository per site | A site's configuration, lockfile, and deploy workflow |

The calendar is part of the core. It shows every date that the enabled modules declare and
publishes ICS feeds.

## Packages

| Package | What it is |
| --- | --- |
| `@hearthlog/contracts` | The shared kernel: the module manifest, tenant configuration, feature registry, and entity definitions |
| `@hearthlog/runtime` | The offline runtime: the local database, events and projections, commands, the outbox and sync, the Ledger client, and history |
| `@hearthlog/ui` | The design system: primitives, overlays, and the data table |
| `@hearthlog/shell` | Layout and navigation, the log panel, the calendar, sync status, and the core pages |
| `@hearthlog/sdk` | The only API a module may import |
| `@hearthlog/cloudflare` | The gateway Worker and the calendar feed Workers |
| `@hearthlog/ledger` | The Ledger Worker: an Elysia app on SQLite Durable Objects, with its backup scripts |
| `@hearthlog/tooling` | The `hearthlog` CLI: build, init, module locks, checks, and deployment |
| `@hearthlog/native` | Optional Mac and iOS shells that open a deployed site (`hearthlog apple:mac`, `apple:ios`) |
| `@hearthlog/czech` | Czech public holidays, working-time rules, and the flat-rate tax estimate |

## Starting a site

A site is a small folder: it names the modules it ships, and `hearthlog build` writes everything
else into a gitignored `.generated/` directory.

```bash
pnpm dlx @hearthlog/tooling init my-site --id my-site --modules none
cd my-site
pnpm install
pnpm dev
```

To add a module, add its package (for example `pnpm add @hearthlog/module-finance`), list its
features in `tenants/<id>/tenant.json`, and run `pnpm exec hearthlog lock` to update
`tenants/<id>/modules.lock.json`. A site's own pages go in `src/routes/`, and a route that
collides with a core or module route is an error. [`examples/empty`](examples/empty) shows
what `init` writes.

## Deploying

`hearthlog` provisions one site from `tenants/<id>/`: `tenant.json` for what it enables,
`deployment.json` for the Cloudflare stack it owns, and `modules.lock.json` for the modules it
ships.

```bash
pnpm exec hearthlog plan --site <id>          # read-only: resources, steps, problems
pnpm exec hearthlog apply --site <id> --yes   # creates resources and deploys; resumable
```

`plan` needs no credentials, and it refuses names that would let one site reach another site's
data. `apply` creates the buckets, the Access application, the Ledger and its application, then
deploys the gateway and checks that the site asks visitors to sign in. Finished steps are recorded
in `.wrangler/tenants/<id>/receipt.json`, so running it again resumes where it stopped. It never
deletes a bucket, a Ledger, or an Access application. Account values (the workers.dev domain, the
Access team, the administrator email) are operator input in `deployment.json`, and secrets come
from the environment.

The site's repository deploys itself through `.github/workflows/deploy.yml`, which `init` writes.
The workflow has a build job without secrets and a deploy job in a protected environment.

## Writing a module

```bash
pnpm -C dev module:new -- notes --feature notes                       # a working module in dev/modules/notes/
pnpm -C dev module:export -- notes --out ../../hearthlog-module-notes  # lay it out as its own repository
```

A module imports only `@hearthlog/sdk/*`, `svelte`, `$app/*`, `~icons/*`, its declared
dependencies, and its own files. It never imports another module or the app's internals, and
`pnpm check:modules` enforces this. The `ModuleManifest` type in
[`packages/contracts/src/index.ts`](packages/contracts/src/index.ts) documents what a manifest may
declare: features and routes, layouts, entities and repositories, a projection version, startup
code, attention badges, styles, gateway routes and bindings, and a public Worker. An exported
module tests itself with `hearthlog check-module`, which builds a throwaway site that enables it.

## Developing the platform

Prerequisites: Node.js 24 and pnpm 10.32.1 (pinned in `package.json`).

| Folder | What it is |
| --- | --- |
| `packages/` | The platform: the `@hearthlog/*` packages |
| `dev/` | The development site: a site like one `hearthlog init` writes, built from the packages in this workspace. The packages' generated code (`@hearthlog/generated`) comes from its build, so type checks, unit tests, and the local app run here |
| `tests/` | Everything only tests use: the browser journeys and their Playwright configs, the Ledger Worker suite, the fixture site of the tooling tests (`tests/fixture-host/`), and the integration variant of the development site |
| `examples/empty` | What `hearthlog init` writes for a site without modules |
| `scripts/` | Releasing, the package and tarball checks, and the integration run |

```bash
pnpm install
pnpm -C dev ledger:dev   # terminal 1: the local Ledger Worker on port 8787
pnpm -C dev dev          # terminal 2: the SvelteKit dev server for the development site
```

```bash
pnpm check:all    # everything; AGENTS.md lists the narrower check for each area
pnpm test         # browser journeys against the development site, hermetic (no Ledger needed)
pnpm test:worker  # the Ledger Worker protocol under wrangler dev
```

This repository installs no module, and the development site enables none. The tests that need
modules run with `pnpm test:integration`. It installs the published `@hearthlog/module-*`
packages into a throwaway project outside the repository and links them in for the run. It then
switches the development site to
[`tests/integration/st.tenant.json`](tests/integration/st.tenant.json), runs the unit and tooling
tests, type checks, and Ledger tests, and removes the links. No `package.json` or lockfile in the
repository ever names a module.

Read [`AGENTS.md`](AGENTS.md) before changing anything. It holds the conventions, the
architecture invariants, and the definition of done. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains
how to contribute.

### Releasing

All packages share one version. To release, run the **Release** workflow from the Actions tab on
`main` and enter the version. It sets that version on every package, runs the release checks, and
commits and tags `v<version>`. After approval in the protected `npm` environment, it publishes
through npm's trusted publishing, with provenance, and creates the GitHub release. Nothing runs
locally.

## Security

Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md). Modules run with the same
privileges as application code, so install only modules you trust.

## License

[AGPL-3.0-only](LICENSE).
