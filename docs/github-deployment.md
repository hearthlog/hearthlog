# GitHub deployment

The application deploys from GitHub Actions. This document lists the repository
configuration required for the pipeline to work, the Cloudflare API-token
permissions it needs, and the runbooks for bootstrap, rotation, and rollback.

## Pipelines

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/st-ci.yml` | pull request | Full frontend gate, including the browser suite |
| `.github/workflows/ledger-ci.yml` | pull request | Ledger types, contracts, bundle, startup, and worker browser checks |
| `.github/workflows/deploy.yml` | push to `main`, manual dispatch | Validate, deploy Ledger when changed, deploy tenant frontends, then deploy and probe the public Gallery Worker when changed |

`main` has exactly one pipeline: `deploy.yml`. It runs its own quality gate
before touching Cloudflare, so the pull-request workflows stay focused on the
full, browser-inclusive test suite.

Inside `deploy.yml`:

1. `quality` — `check:scripts`, script unit tests, `check:ts`, `check:tenants`,
   unit tests, `ledger:check`, `ledger:test`.
2. `changes` — detects whether `ledger/**` and/or frontend inputs changed.
3. `matrix` — resolves the tenant list from `tenants.json` via
   `pnpm list:sites`. Sites on their own stack (`tenants/<id>/deployment.json`)
   are left out; they are deployed from a machine (see
   [Copying a tenant](tenant-copy.md)).
4. `deploy-ledger` — deploys `st-ledger` (only when `ledger/**` changed, or on
   manual dispatch).
5. `deploy-ledger-admin` — verifies Access and deploys `st-ledger-admin`
   (production only, skipped on dry runs).
6. `deploy-tenants` — one matrix job per site: `ensure:tenant` then
   `deploy:tenant`.
7. `deploy-gallery-public` — after tenant provisioning, deploy the isolated
   public Gallery Worker once and verify its anonymous production route.
8. `deploy-calendar-public` — after the tenant jobs (the feed Worker binds every
   site Worker's renderer entrypoint), deploy the public calendar feed Worker
   once and verify its anonymous route.

Backend-first ordering is enforced with `needs:`; when the backend is
intentionally skipped, the tenant jobs still run. Each tenant job is
independent (`fail-fast: false`), so one site's failure does not stop the
others. The workflow uses `concurrency: deploy-production` with
`cancel-in-progress: false`, so overlapping pushes queue instead of racing.
The public Gallery job runs for public Worker/config changes or a manual run
without a single-site filter.
Its dry run bundles without upload or a live probe. A real deploy fails if
Cloudflare serves a placeholder, Access redirect, or another response instead
of the Gallery Worker. A link is only usable after this job passes; the private
publication endpoint's successful R2 write alone cannot verify public routing.

## Tenant workflow (a site on its own stack)

`packages/tooling/templates/tenant/github-workflows/deploy.yml.tmpl` is the workflow a tenant repository gets
(`hearthlog init` and `hearthlog export` write it to `.github/workflows/deploy.yml`). A site on its own stack deploys from that
repository, not from this one ([handing a site over](tenant-handover.md)); this repository's `deploy.yml` deploys only the sites
of the shared stack. It has two jobs.

- **`build`** has no secrets, and runs on pull requests too. It installs the locked dependencies, prints the read-only
  plan, builds the site and its public Gallery Worker, and seals the result: `hearthlog artifact manifest` writes
  `artifact-manifest.json` with the hash of every file under `build/` and `.generated/` and of `pnpm-lock.yaml`. The
  release (`build`, `.generated`, the manifest) is uploaded as the `release` artifact.
- **`deploy`** runs on pushes and manual dispatch, in the protected environment named after the tenant, so it starts
  only after a reviewer approves, and the secrets exist only in that environment. It installs the same lockfile with
  scripts disabled, downloads `release`, runs `hearthlog artifact verify` (any changed, missing, or extra file, or a
  different lockfile, stops it), and runs `hearthlog apply --site <id> --yes --skip-build --no-bootstrap`. The secrets
  are on that one step, not on the job. The receipt (`.wrangler/tenants/<id>/receipt.json`, no secrets) is uploaded as
  the `receipt` artifact, so a run's receipt starts empty and every idempotent step runs.

**It never creates credentials.** With no administrator token for the Ledger it stops (`--no-bootstrap`, also implied
by `CI`). Provision the stack once on your machine with `hearthlog apply --site <id> --yes`, then put the token in the
environment as `LEDGER_ADMIN_TOKEN`.

Set up the environment under *Settings → Environments → `<id>`*: required reviewers, deployment branch `main`, and the
secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `LEDGER_ADMIN_TOKEN` (this site's Ledger), and optionally
`INVOICE_RENDERER_TOKEN`, `VERTEX_API_KEY`, and `VERTEX_SERVICE_ACCOUNT`. Actions are pinned to full commit SHAs
(the version is in a comment); update them together.

Locally, `hearthlog artifact manifest|verify`, `hearthlog gallery-public:build`, and `hearthlog apply --dry-run` run
the same commands (`ensure` and the Cloudflare Access check need `CLOUDFLARE_API_TOKEN`, so a full dry run does too).

## Required repository secrets

Set these under **Settings → Secrets and variables → Actions → New repository
secret**.

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes | Wrangler deploys, `wrangler secret bulk`, R2 bucket ensure, and Cloudflare Access provisioning (add "Access: Service Tokens -> Edit" for sites with integrations) |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Avoids token-based account discovery |
| `LEDGER_ADMIN_TOKEN` | yes | Mints tenant Ledger tokens at bootstrap and deploys `st-ledger-admin` |
| `INVOICE_RENDERER_TOKEN` | recommended | Pushed to every Worker for invoice PDF rendering |
| `VERTEX_API_KEY` | optional | Mapped to `INVOICE_EXTRACTION_API_KEY` for AI invoice reading |
| `VERTEX_SERVICE_ACCOUNT` | optional | Mapped to `INVOICE_EXTRACTION_SERVICE_ACCOUNT` (service-account JSON) |
| `CF_ACCESS_ADMIN_AUD` | optional | Access audience for the admin-path application on the admin site |

`INVOICE_RENDERER_TOKEN`, `VERTEX_API_KEY`, and `VERTEX_SERVICE_ACCOUNT` are
optional: when absent, the ensure step simply does not push them, and the
corresponding UI features stay disabled (the routes answer `503`). In CI the
environment values replace the local gcloud lookup, so the gcloud CLI is not
needed.

No GitHub *variables* are required. No GitHub *Environments* or deployment
approvals are configured — production deploys automatically on every push to
`main`. To add a required reviewer later, give the `deploy-tenants` (and
`deploy-ledger`) jobs an `environment:` key; the scripts do not depend on it.

## Cloudflare API token

Create an **Account-scoped** API token at
<https://dash.cloudflare.com/profile/api-tokens> with these permissions:

| Scope | Permission | Needed for |
| --- | --- | --- |
| Account | Workers Scripts → Edit | `wrangler deploy`, `wrangler secret bulk`, Durable Object deploys |
| Account | Workers R2 Storage → Edit | `wrangler r2 bucket list/create` |
| Account | Access: Apps and Policies → Edit | creating/adopting Access applications and Allow policies |
| Account | Access: Organizations, Identity Providers, and Groups → Edit | reconciling the team-wide Access session duration |
| Account | Account Settings → Read | account discovery (skip by setting `CLOUDFLARE_ACCOUNT_ID`) |

Optionally restrict the token to the single Cloudflare account that hosts the
Workers. The same token is used for local `ensure:tenant` runs; locally,
Wrangler deploys fall back to the OAuth session
(`pnpm exec wrangler login`) unless `STOR_WRANGLER_API_TOKEN=1` is set, because
an Access-only token cannot push Worker secrets.

## Ledger admin token

`LEDGER_ADMIN_TOKEN` is the value of the Ledger Worker's `ADMIN_TOKEN` secret.
Cloudflare never returns Worker secret values, so the value must be kept
somewhere you control:

```bash
# Set (or overwrite) the Ledger Worker's admin token:
pnpm exec wrangler secret put ADMIN_TOKEN --config .generated/shared/ledger/wrangler.jsonc
```

Store the same value as `LEDGER_ADMIN_TOKEN`. The tenant Workers' documented
local fallback is the gitignored `.wrangler/tenants/.admin-token`; CI reads the
secret instead. If the value is lost, overwrite it with a new value and update
everywhere:

```bash
pnpm exec wrangler secret put ADMIN_TOKEN --config .generated/shared/ledger/wrangler.jsonc
pnpm exec wrangler secret put LEDGER_ADMIN_TOKEN          # admin site Worker
pnpm exec wrangler secret put LEDGER_ADMIN_TOKEN --config wrangler.bravo.jsonc
```

## Bootstrap and new tenants

Everything in the tenant lifecycle is idempotent; a new site needs no dashboard
work beyond adding it to `tenants.json`.

1. Add `tenants/<id>/tenant.json` (id, `authorizedEmails`, features, theme,
   and the `admin` flag as needed).
2. Run `pnpm check:tenants` to validate the config and generated Wrangler
   configs.
3. Commit and push to `main`.

The next `deploy.yml` run then, for that site:

- ensures the shared R2 buckets exist,
- registers the Ledger application (`POST /admin/v1/apps`) and mints its token,
- creates the Cloudflare Access application for the site's workers.dev hostname
  and reconciles its Allow policy to exactly `authorizedEmails` (an email
  removed here loses access on the next run); a policy promoted to reusable in
  Cloudflare is updated through the account-level policies endpoint, which is
  the only one that accepts those changes; Workers preview URLs stay
  disabled (`preview_urls: false`) so no other hostname bypasses it,
- pushes `LEDGER_AUTH_TOKEN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_APP_AUD`,
  `INVOICE_RENDERER_TOKEN`, and the Vertex credentials to the Worker,
- builds and deploys the frontend.

**A Ledger token is minted only when the application is created.** An existing
application is left untouched because its single principal cannot be rotated
without revoking the token the Worker is already using and dropping live
WebSockets. On every later deploy the ensure step only re-checks R2 and Access.

To run the same steps locally for one site:

```bash
pnpm ensure:tenant -- --site <id>
pnpm deploy:tenant -- --site <id>
```

## Manual runs

**Actions → Deploy → Run workflow** exposes:

| Input | Meaning |
| --- | --- |
| `site` | deploy one site id; empty deploys every site |
| `dry_run` | build and bundle without uploading |
| `rotate_token` | mint a replacement Ledger token (requires `site`) |

The equivalent CLI invocations:

```bash
pnpm deploy:tenant -- --site st --dry-run
pnpm ensure:tenant -- --site st --rotate-token   # invalidates the old token
```

## Rotation

`--rotate-token` (or the `rotate_token` input with a `site`) calls
`POST /admin/v1/apps/:id/rotate-token`, stores the new token in the Worker, and
pushes it. Rotating revokes the previous principal and closes that tenant's live
WebSockets, which clients recover from on reconnect; use it only when a token
must be replaced, not on every deploy.

## Rollback

Cloudflare cannot atomically commit several Workers, so there is no cross-Worker
transaction. Every Worker keeps its own version history; roll one back on its
own.

```bash
# List and roll back a tenant frontend:
# (the config is generated by `pnpm build:generated`; `st` is the same, with `.generated/sites/st/`)
pnpm exec wrangler deployments list --config .generated/sites/bravo/wrangler.jsonc
pnpm exec wrangler rollback <deployment-id> --config .generated/sites/bravo/wrangler.jsonc

# The shared Ledger backend:
pnpm exec wrangler deployments list --config .generated/shared/ledger/wrangler.jsonc
pnpm exec wrangler rollback <deployment-id> --config .generated/shared/ledger/wrangler.jsonc
```

Roll back the Ledger backend last: the frontends bind to it through the
`LEDGER` service binding. Keep backend and storage migrations
backward-compatible across the release window — Durable Object, KV, R2, and D1
state is not versioned, and Durable Object lifecycle changes can prevent
rollback.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cloudflare Access cannot run without CLOUDFLARE_API_TOKEN` | Add the token with **Access: Apps and Policies → Edit**, or run locally with `--skip-access` |
| `No Ledger admin token` | Set `LEDGER_ADMIN_TOKEN`, or run with `--skip-ledger` |
| `The CLOUDFLARE_API_TOKEN needs the "Access: Apps and Policies → Edit"` | The token lacks the Access scope |
| Tenant deploys but the app shows a gateway error | The Worker's `LEDGER_AUTH_TOKEN` is missing/stale; run `ensure:tenant -- --site <id> --rotate-token` to mint and push a replacement (rotating revokes the old token) |
| Invoice PDFs or AI reading answer `503` | `INVOICE_RENDERER_TOKEN` / Vertex secrets are not set; the features hide themselves |
| `deploy-ledger-admin` fails the Access preflight | Fix the dedicated admin-path Access application (host-wide, one Allow policy, one-hour session) before deploying |
| A push changed only `ledger/**` and no tenant deployed | Expected: `changes` gates tenant jobs to frontend-affecting paths |

### Access session lifetimes

`tenants.json` declares `infrastructure.accessSessionDuration` and
`infrastructure.accessGlobalSessionDuration`, both currently `168h` (seven days).
Values must be whole hours from `1h` to `720h`. The application setting is
reconciled on every tenant's host-wide Access application and its Allow policies;
the integrations application and the dedicated Ledger admin application
retain their own settings. The global setting applies to the entire Access team,
including applications outside Hearthlog. Provisioning checks the organization against
`accessTeamDomain` before updating it. The organization PUT sends the existing
`auth_domain` and `name` alongside `session_duration`: Cloudflare rejects an update
without the existing auth domain, despite documenting that field as optional.
Other response fields are omitted to avoid replaying values that fail update
validation.

The existing deployment workflow runs this reconciliation through `ensure:tenant`.
The API token also needs **Access: Organizations, Identity Providers, and Groups →
Edit**. To preview only the Access changes, run:

```bash
pnpm ensure:tenant -- --site st --skip-r2 --skip-ledger --dry-run
```

Omit `--dry-run` to apply; omit `--site st` to reconcile all configured tenant
applications. Existing signed tokens retain their issued expiration; newly issued
tokens use the configured duration. Restore the previous durations in
`tenants.json` and rerun provisioning to roll back the configuration.
