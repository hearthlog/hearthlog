# Hearthlog

Hearthlog is an offline-first platform for personal and household data: finances, invoices,
photos, health, and a shared calendar. It runs in the browser, keeps working without a network,
and synchronizes through an event store that you deploy to your own Cloudflare account.

> **Status: pre-release.** The platform is being split into this repository, one repository per
> module, and private repositories for each deployment. Packages are not on npm yet, and the
> repositories listed below are being filled in. See
> the repository split plan.

## What it does

- **Offline first.** The browser keeps the full event history and the read models in SQLite
  (WebAssembly, stored in the browser's private file system). Every page works offline, and
  changes queue in a durable outbox until the network returns.
- **Event sourced.** Commands validate and append immutable events; projections turn them into
  queryable tables. Nothing is edited in place, so history, authorship, and forks of a log are
  always available.
- **Modular.** A module is a feature packaged on its own: pages, entities, repositories, and
  optional server code. The core knows nothing about invoices or photos; modules declare what
  they need in a manifest (`hearthlog.module.json`).
- **Yours.** One tenant is one deployment: its own Ledger, buckets, and access rules. Credentials
  stay on the server side and are never shipped to the browser.

## Modules

| Module | What it covers |
| --- | --- |
| Calendar (core) | One calendar over every date that modules declare, with public ICS feeds |
| Finance | Assets, a month-by-month transaction timeline, budgets, and plans |
| Invoices | Issuing and receiving invoices, PDF generation, and AI-assisted extraction |
| Gallery | Private photo library with albums and an explicit public export |
| Health | Nutrition, activity, body measurements, and a day view across them |
| Calc | Small calculators |

Write your own with [`docs/modules.md`](docs/modules.md).

## How it fits together

```text
Browser (SvelteKit)
  ├─ OPFS SQLite: raw events, outbox, projections
  └─ /api/ledger
       └─ Frontend Worker: authentication, same-origin gateway
            └─ LEDGER service binding
                 └─ Ledger Worker
                      ├─ AppRegistry Durable Object
                      └─ LedgerApp Durable Objects
```

HTTP is authoritative for append, replay, and recovery; WebSockets only deliver ordered live
batches. Read [the overview](docs/overview-and-operations.md) and
[offline sync](docs/offline-sync.md) for the details.

## Repositories

| Repository | Holds |
| --- | --- |
| [`hearthlog`](https://github.com/hearthlog/hearthlog) | The platform: shell, runtime, Ledger, gateway, tooling |
| `hearthlog-module-calc`, `-health`, `-gallery`, `-finance`, `-invoices` | The first-party modules |
| One private repository per deployment | A tenant's configuration, lockfile, and workflows |

## Getting started

Prerequisites: Node.js 24 and pnpm 10.32.1 (pinned in `package.json`).

```bash
pnpm install
pnpm ledger:dev   # terminal 1: local Ledger Worker on port 8787
pnpm dev          # terminal 2: SvelteKit dev server
```

Run the checks that cover your change, or everything:

```bash
pnpm check:all
```

Before you change anything, read [`AGENTS.md`](AGENTS.md): it holds the conventions, the
architecture invariants, and the definition of done. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains
how to contribute.

## Deploying

Tenants are described in `tenants.json` (or `tenants/<id>/`) and deployed with the tooling in
`@hearthlog/tooling`:

```bash
pnpm hearthlog plan --site <id>          # read-only: what would be created
pnpm hearthlog apply --site <id> --yes   # create resources and deploy, resumably
```

[`docs/deploying-a-tenant.md`](docs/deploying-a-tenant.md) walks through it, and
[`docs/overview-and-operations.md`](docs/overview-and-operations.md) covers the Cloudflare setup.

## Documentation

| Topic | Where |
| --- | --- |
| Modules and the SDK | [`docs/modules.md`](docs/modules.md) |
| Adding a page or an entity | [`docs/adding-a-page.md`](docs/adding-a-page.md), [`docs/adding-an-entity.md`](docs/adding-an-entity.md) |
| Offline sync and the Ledger protocol | [`docs/offline-sync.md`](docs/offline-sync.md), [`packages/ledger/docs/`](packages/ledger/docs/) |
| The platform plan | `docs/modular-platform-architecture.md` |
| Publishing and the snapshot | [`docs/open-source.md`](docs/open-source.md) |
| Tests | [`docs/testing-strategy.md`](docs/testing-strategy.md) |

## Security

Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md). Modules run with the same
privileges as application code; install only modules you trust.

## License

[AGPL-3.0-only](LICENSE).
