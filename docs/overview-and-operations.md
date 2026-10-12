# Hearthlog: overview and operations

The standalone Ledger admin console shares Hearthlog's UI
components and has its own build, Worker and Cloudflare Access boundary.

Hearthlog is an offline-first SvelteKit application backed by the Ledger event-store
service. The frontend, the Ledger Cloudflare Worker, and the same-origin
gateway live in this repository with explicit build and deployment boundaries.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/`, `static/`, `tests/` | SvelteKit application, static assets, and browser tests |
| `scripts/` | Frontend generation, preview, and build-analysis tools |
| `ledger/` | Elysia Worker, SQLite Durable Objects, contracts, tests, and backup tooling |
| `worker/` | Frontend static-asset Worker and same-origin Ledger service-binding gateway |
| `apple/` | Swift shells that open the deployed site as a Mac and an iOS app (`docs/native-shell.md`) |
| `.github/workflows/st-ci.yml` | Frontend checks and production build |
| `.github/workflows/ledger-ci.yml` | Ledger type, contract, bundle, startup, and browser checks |

## Architecture

For the proposed evolution toward independently released modules and tenant-owned
Cloudflare deployments, see Hearthlog as a modular, self-hosted platform.
That document is a design proposal; the architecture below describes the current app.

The browser keeps tenant- and log-scoped event history, a durable outbox, and
read models in SQLite WASM backed by OPFS. It remains usable offline and
synchronizes when a network connection is available.
The installed service worker caches the complete built app, including pages
and lazy UI code, so a section does not need to be opened online first.
Private files use their feature-specific device stores; they are not
automatically downloaded with the app bundle.

In production, the browser calls the same-origin `/api/ledger` gateway. The
frontend Worker verifies the Cloudflare Access identity against the site's
authorized emails, injects `LEDGER_AUTH_TOKEN`, and forwards the request
through the `LEDGER` service binding without browser cookies. It also stamps the
verified email in `X-Ledger-Actor`, which Ledger records as the author of
appended events (Log history names authors other than you). The long-lived credential is never bundled into
the browser. Realtime delivery uses gateway-authenticated `ledger.v1`
WebSockets.

Ledger administration is separately exposed at
`/api/ledger/admin/v1/*`. A path-specific Cloudflare Access application admits
only `owner@example.com`. The frontend Worker verifies the Access JWT,
then replaces browser credentials with its `LEDGER_ADMIN_TOKEN` before calling
the same Ledger service binding. The administrator token is never available to
browser code.

```text
SvelteKit browser
  ├─ OPFS SQLite: raw events, outbox, and projections
  └─ /api/ledger
       └─ frontend Worker: HTTP and WebSocket authentication
            └─ LEDGER service binding
                 └─ Elysia Worker
                      ├─ AppRegistry SQLite Durable Object
                      └─ LedgerApp SQLite Durable Objects + hibernating sockets
```

Ledger HTTP is authoritative for append, replay, and recovery. WebSockets only
deliver ordered live batches and reconnect signals. See
`packages/runtime/src/ledger/README.md`, `docs/offline-sync.md`, and the canonical
`packages/ledger/docs/event-store-service.openapi.yaml` contract.

The [invoice document generation contract](invoice-generation.openapi.yaml)
defines PDF requests from the invoices page, rendered by a separately deployed
service. The frontend Worker proxies `/api/invoice-generation/*` to that
renderer and attaches the `INVOICE_RENDERER_TOKEN` secret. Generated PDFs are
cached in the private `INVOICE_PDFS` bucket and on the device; the scoped
`/api/invoice-generation/logs/*` routes verify the Ledger log before serving or
storing anything. See the
[field mapping and generation rules](invoice-generation.md) for the
snapshot contract, cache fingerprinting, and decimal calculations.

The Invoices page also has a **Received** tab for supplier PDFs. These are
uploaded originals, never sent to the invoice renderer. Invoice metadata is a
separate log-scoped entity; the PDF is cached in device IndexedDB and queued
for upload while offline. Selecting a PDF reads an embedded ISDOC electronic
invoice on the device and prefills the form from it; when the PDF carries none,
a supplier ISDOC file can be uploaded separately, the invoice can be read with
AI, or the fields can be entered manually. The XML is retained as an
immutable `received-isdoc/v1/` object through the sibling
`/api/received-invoice-files/v1/logs/{logId}/invoices/{invoiceId}/isdoc/{fileId}`
route. The same-origin
`/api/received-invoice-files/v1/logs/{logId}/invoices/{invoiceId}/files/{fileId}`
route verifies the Ledger log and stores immutable PDF versions under a
distinct `received/v1/` prefix in the private `INVOICE_PDFS` bucket. Editing or
removing an invoice retains prior document versions so history and Undo can
recover them. See
[received-invoice extraction](received-invoice-extraction.md) for the
mapping, warnings, and storage details.

## Getting started

Prerequisites:

- Node.js 24
- pnpm 10.32.1, pinned by `package.json`

Install dependencies:

```bash
pnpm install
```

### Configuration

| File | Variables |
| --- | --- |
| `/.env` | Frontend `VITE_LEDGER_*`, optional `VITE_KAL_API_BASE_URL`, and other client settings; see `/.env.example` |
| `/.dev.vars` | Frontend Worker secrets; see `/.dev.vars.example` |
| `/ledger/.dev.vars` | Local Ledger Worker secrets; see `/ledger/.dev.vars.example` |

Production builds should leave browser identity variables unset and use
`VITE_LEDGER_SERVICE_URL=/api/ledger`. Configure the frontend Worker's
`LEDGER_AUTH_TOKEN` secret instead. Local development uses the same browser
contract; Vite holds the local app token server-side.

### Development

Start Ledger and Vite in separate terminals:

```bash
pnpm ledger:dev
pnpm dev
```

`pnpm ledger:dev` starts Wrangler on port 8787 and uses the ignored
`ledger/.dev.vars` file. `pnpm dev` checks Ledger health, reuses or provisions
a local app with the administrator token from that file, stores its credential
at ignored `.wrangler/development/st-local-ledger.json` with mode `0600`, and
starts Vite on the first available port beginning with 5173. Multiple local
frontend instances can therefore run concurrently. Each instance validates
Ledger requests against its actual same-origin host and port before proxying
`/api/ledger` HTTP requests and `ledger.v1` WebSocket upgrades to the local
Worker. The app token is never placed in a `VITE_*` variable or sent to
browser code.

If the local Ledger state or signing key is reset, the next `pnpm dev`
provisions a replacement credential automatically.

### Quality checks

Run the aggregate baseline:

```bash
pnpm check:all
```

The focused commands are:

```bash
pnpm check:ts
pnpm test:unit --run
pnpm build
pnpm frontend:worker:check
pnpm ledger:types
pnpm ledger:check
pnpm ledger:test
pnpm ledger:dry-run
pnpm test
pnpm test:preview
pnpm test:worker
```

The browser suite (`pnpm test`) is hermetic: `VITE_E2E=1` disables network
sync and realtime, and the dev server answers the Ledger contract locally, so
it needs no `pnpm ledger:dev`. It is a handful of core app journeys.
`pnpm test:preview` builds the default site and checks that every page renders
and the app installs for offline use (`playwright.preview.config.ts`). CI runs
both, each in one job.
The coverage split and criteria for new browser cases are in
[`docs/testing-strategy.md`](testing-strategy.md).

The fuller `pnpm check` command remains available, but the current
`svelte-check` release is incompatible with this repository's TypeScript 7
toolchain. CI uses direct TypeScript validation, the production build, and the
unit/browser suites until that upstream incompatibility is resolved.

## Deployment

Deployment runs from `.github/workflows/deploy.yml` on every push to `main`
(and on manual dispatch). The pipeline validates, deploys the shared Ledger
backend only when `ledger/**` changed, then builds and deploys each tenant
frontend as its own matrix job. The required repository secrets and the exact
Cloudflare API-token permissions are documented in
[docs/github-deployment.md](github-deployment.md).

Local runs use the same scripts as CI:

```bash
pnpm ensure:tenant -- --site st           # register/protect one tenant (idempotent)
pnpm deploy:ledger                        # validate + deploy the Ledger backend
pnpm deploy:tenant -- --site st           # build + deploy one frontend
pnpm deploy:tenant -- --site st --dry-run # build and bundle without uploading
```

`ensure:tenant` is idempotent: it ensures the shared R2 buckets, the
site's Cloudflare Access application and Allow policy, and the site's Ledger
application. A Ledger token is minted only when the application is created (or
with an explicit `--rotate-token`); an existing application is left untouched
because rotating revokes the only principal and drops live WebSockets. Worker
secrets are pushed automatically on a bootstrap/rotation and with
`--set-secret`. The Ledger URL is derived from the Ledger Worker's name in the shared infrastructure;
`--ledger-url` overrides it for a local Ledger or custom domain. The admin
token comes from `LEDGER_ADMIN_TOKEN` (or the gitignored
`.wrangler/tenants/.admin-token`).

Each tenant deploys independently, so one site's failure does not touch the
others. Cloudflare cannot atomically commit several Workers, so there is no
cross-Worker transaction; roll back a single Worker with Cloudflare's native
version history:

```bash
pnpm exec wrangler deployments list --config wrangler.bravo.jsonc
pnpm exec wrangler rollback <deployment-id> --config wrangler.bravo.jsonc
pnpm exec wrangler rollback <deployment-id> --config .generated/shared/ledger/wrangler.jsonc
```

Keep backend and storage migrations backward-compatible across the release
window: Durable Object, KV, R2, and D1 state is not versioned, and Durable
Object lifecycle changes can prevent rollback.

Worker secrets are write-only: Cloudflare never returns their values, so
`wrangler secret list` shows names only and a token set earlier cannot be
read back. Keep a local copy of `ADMIN_TOKEN` in the gitignored
`.wrangler/tenants/.admin-token`, which `ensure:tenant` reads as a
fallback for `LEDGER_ADMIN_TOKEN`. If the value is ever lost, overwrite it
without knowing the previous one and mirror the new value everywhere:

```bash
pnpm exec wrangler secret put ADMIN_TOKEN --config .generated/shared/ledger/wrangler.jsonc
pnpm exec wrangler secret put LEDGER_ADMIN_TOKEN
pnpm exec wrangler secret put LEDGER_ADMIN_TOKEN --config wrangler.bravo.jsonc
```

The site Workers' `LEDGER_ADMIN_TOKEN` must hold the same value as the
Ledger Worker's `ADMIN_TOKEN`.

Deploy Ledger before the frontend Worker so the service-binding target exists:

```bash
pnpm exec wrangler secret put ADMIN_TOKEN --config .generated/shared/ledger/wrangler.jsonc
pnpm exec wrangler secret put TOKEN_SIGNING_KEY_CURRENT --config .generated/shared/ledger/wrangler.jsonc
pnpm ledger:dry-run
pnpm exec wrangler deploy --config .generated/shared/ledger/wrangler.jsonc
```

The production Worker is named `st-ledger`. The `LedgerApp` and `AppRegistry`
class names, bindings, and SQLite-backed Durable Object identities are
deployment and data contracts.

Then configure and deploy the frontend gateway:

```bash
pnpm exec wrangler secret put LEDGER_AUTH_TOKEN
pnpm exec wrangler secret put LEDGER_ADMIN_TOKEN
pnpm exec wrangler secret put CF_ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put CF_ACCESS_ADMIN_AUD
pnpm exec wrangler secret put CF_ACCESS_APP_AUD
pnpm exec wrangler r2 bucket create st-invoice-pdfs
pnpm build
pnpm frontend:worker:dry-run
pnpm exec wrangler deploy
```

The `st` site's generated Worker config (`.generated/sites/st/wrangler.jsonc`) binds `LEDGER` to `st-ledger`. Set `LEDGER_ADMIN_TOKEN` to
the same value as the target Ledger Worker's `ADMIN_TOKEN`.

`INVOICE_RENDERER_TOKEN` is the bearer credential of your invoice renderer. Put it in the
environment of the machine or CI job that runs `pnpm ensure:tenant -- --set-secret` (the CI
repository secret of the same name), and set `infrastructure.invoiceRendererOrigin` in
`tenants.json` to the renderer's HTTPS origin. Without both, the invoice rendering routes answer
503 and the app hides PDF generation. To push the token by hand:

```bash
printf %s "$INVOICE_RENDERER_TOKEN" | pnpm exec wrangler secret put INVOICE_RENDERER_TOKEN
```

AI invoice reading is optional and calls Gemini through Vertex AI in a Google Cloud project of
your choice, so the Vertex AI API must be enabled there
(`gcloud services enable aiplatform.googleapis.com --project <your project>`).
Provide exactly one credential: an express-mode API key
(`INVOICE_EXTRACTION_API_KEY`) or a service-account JSON
(`INVOICE_EXTRACTION_SERVICE_ACCOUNT`) with `roles/aiplatform.user` and a key.
`pnpm ensure:tenant -- --set-secret` pushes whichever is set in the
environment; in CI set the `VERTEX_API_KEY` or `VERTEX_SERVICE_ACCOUNT`
repository secret. Without one the extraction route answers `503` and the UI
hides its button. Model and location are optional Worker variables
(`INVOICE_EXTRACTION_MODEL`, default `gemini-3.8-flash`, and
`INVOICE_EXTRACTION_LOCATION`, default `global`); set them only to override the defaults. See
[received-invoice extraction](received-invoice-extraction.md#phase-2-setup).

AI decisions (a suggested transaction category, an invoice expense type) use a
Workers AI binding, so they need no key. A site opts in with `ai` in
`tenants.json`; see [AI decisions](ai-decisions.md).

Service sources such as an iPhone Shortcut can log daily steps through a
service token; see [Service ingest](service-ingest.md).

The invoice-PDF bucket must exist before the frontend is deployed. Keep it
private; the frontend binds `st-invoice-pdfs`.
`CF_ACCESS_APP_AUD` is the audience for the general Hearthlog Access application,
and `STOR_AUTHORIZED_EMAILS` in the generated Worker config lists the site's
`authorizedEmails` from `tenants.json` for invoice-PDF and other file
requests. The buckets are declared in `tenants.json` under `infrastructure`
and bound by every generated tenant config; `pnpm ensure:tenant` creates them.

Before enabling the UI, create a self-hosted Cloudflare Access application
more specific than the general Hearthlog application:

- Application path: `/api/ledger/admin/v1/*` on the production hostname.
- One Allow policy containing only `owner@example.com`.
- No broader Hearthlog Allow policy on this application.
- `CF_ACCESS_TEAM_DOMAIN`: the HTTPS team origin, for example
  `https://your-team.cloudflareaccess.com`.
- `CF_ACCESS_ADMIN_AUD`: the application audience shown by Access.

The administrator email is configured as `LEDGER_ADMIN_EMAIL` in
the generated Worker config (from `infrastructure.ledgerAdminEmail`).

## Sites & tenants

A site is defined in its own directory, `tenants/<id>/`: `tenant.json` (id,
features, branding, authorized emails), `modules.lock.json`, `static/` (its
icons and other brand files, served at the same paths), and, for a site on its
own stack, `deployment.json`. `tenants.json` at the repository root is optional:
it holds the **shared stack's** infrastructure identifiers (Ledger worker,
invoice-PDF and gallery buckets, admin email, Access team domain) under
`infrastructure`, the `defaults` of the sites that use it, and which of them
sweeps the shared public Gallery bucket (`infrastructure.gallerySweeper`). A
repository whose sites all run on their own stacks has none. Each site is
its own frontend Worker bound to its own Ledger application; **no per-tenant
wrangler configuration is maintained by hand**. Every site's Worker config
is generated into
`.generated/sites/<id>/wrangler.jsonc` from
`tenant.json`, the site's modules, and the shared base in
`packages/tooling/src/tenants/wrangler-base.ts`; `hearthlog build`, the deploy
tools, and `pnpm check:tenants` regenerate them.

A site with `tenants/<id>/deployment.json` runs on its own stack instead: its
own Ledger Worker, buckets, and public Gallery and calendar feed Workers, named
from the file's `resourcePrefix`, in the account the file names (its
`workersDevDomain`, `authentication`, `ledgerAdminEmail`, and the optional
renderer and food-catalog origins and session lengths replace the shared values;
the first three are required when there is no `tenants.json`). CI leaves such a site out; it is deployed from
a machine with `pnpm deploy:ledger -- --site <id>` and
`pnpm deploy:tenant -- --site <id>`. `jst` is one, filled by a copy of `alpha`;
see [Copying a tenant](tenant-copy.md).

| Site | Features |
| --- | --- |
| `st` | Everything (this deployment) |
| `bravo` | Calendar, Calories, and BMI (title "bravo", violet accent) |

- `pnpm check:tenants` validates the tenant files and verifies the generated
  wrangler configs against them.
- `tenants.schema.json` gives editors completion and validation for
  `tenants.json`. It is generated from the feature, AI, and integration lists;
  run `pnpm generate:tenant-schema` after changing them (`check:tenants` fails
  while it is stale).
- `pnpm generate:icons` re-renders each site's icons into
  `tenants/<site>/static/icons/<site>/` (committed). Run it after changing the brand mark or a
  site accent.
- `VITE_STOR_TENANT=<site> pnpm build` builds a site into `build/<site>`;
  the default tenant `st` keeps the historical `./build` output.
  `VITE_STOR_TENANT=<site> pnpm dev` previews another tenant locally.
- `pnpm ensure:tenant -- --site <id>` is idempotent: it ensures the site's
  Ledger application, Cloudflare Access application and Allow policy, and the
  environment's R2 buckets, then pushes Worker secrets on a bootstrap or
  rotation. `--set-secret` forces a refresh, `--rotate-token` mints a
  replacement Ledger token (only when explicitly requested), and `--dry-run`
  prints the plan. `pnpm provision:tenants` runs it for every site.
- `pnpm deploy:ledger` validates and deploys the shared Ledger backend.
- `pnpm deploy:tenant -- --site <id>` builds and deploys one frontend Worker;
  `--dry-run` bundles the Worker without uploading.
- `pnpm ledger:export:tenants` backs up every site's Ledger application using
  the canonical logical-backup format.

Feature gating derives from `packages/contracts/src/features/registry.ts`, the single
registry of pages: navigation, the route guard (disabled
routes redirect to the site's home), and the command menu entries all
consume it. The Developer
and Entities routes are separately tenant-configured; hidden routes are
blocked on direct access, and administrator functions render only where the
gateway holds `LEDGER_ADMIN_TOKEN`.

Opening `/` (including the installed PWA) resumes the last feature section
visited on this device for the current site. It remembers only the section,
not filters, selected records, dates, or action links. On a new
device it opens the site's configured `home` feature when one is set, or the
first enabled section. The former Today page is gone; `/today` redirects to
the start section. Direct page links always open their own route.

### Cloudflare automation (Access applications, Ledger, buckets & secrets)

`pnpm ensure:tenant` automates everything Cloudflare-side that used to be done
in the dashboard. It is idempotent and runs automatically in the deploy
pipeline before each tenant is built. With `CLOUDFLARE_API_TOKEN` (Workers
Scripts:Edit for deploys and secret bulk; add **Access: Apps and Policies →
Edit**, plus **Account Settings → Read** unless `CLOUDFLARE_ACCOUNT_ID` is set)
and the Ledger admin token it will, per site:

- ensure the shared R2 buckets exist (without deleting anything),
- register the site's Ledger application when it is missing, minting its token
  once; an existing application keeps its token unless `--rotate-token` is
  passed,
- ensure a Cloudflare Access application for the site's workers.dev hostname,
  adopting the existing one when present (so a manually created `st`
  application is reused, not duplicated), and reconcile its Allow policy to
  exactly the site's `authorizedEmails` — an email removed from
  `tenants.json` loses access on the next run,
- push `LEDGER_AUTH_TOKEN` (bootstrap/rotation only), the shared Access team
  domain (`CF_ACCESS_TEAM_DOMAIN`), and the adopted Access application's
  audience (`CF_ACCESS_APP_AUD`) into the site's Worker via one
  `wrangler secret bulk` request. In CI this uses `CLOUDFLARE_API_TOKEN`;
  locally it uses the Wrangler OAuth login.

Other flags: `--rotate-token` (mint a replacement Ledger token),
`--set-secret` (push secrets even when nothing was minted), `--dry-run`,
`--skip-r2` / `--skip-access` / `--skip-ledger` / `--skip-secrets`.

Adding a site: add `tenants/<id>/tenant.json` (that is the only edit — no
wrangler changes), run `pnpm check:tenants`, then
`pnpm ensure:tenant -- --site <id>` and `pnpm deploy:tenant -- --site <id>`, or
just push to `main`. The wrangler config, Access application, authorized-email
policy, and all required Worker secrets are handled by the tooling — no
dashboard clicks.
