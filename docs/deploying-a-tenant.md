# Deploying a tenant

`pnpm hearthlog` provisions one tenant from its files in `tenants/<id>/`
(`tenant.json`, `deployment.json`, `modules.lock.json`; see
[tenant-copy.md](tenant-copy.md) for what each holds). It is the resumable
version of the manual runbook there, built from the same tools. They run from the `@hearthlog/tooling` package
(`hearthlog ensure`, `deploy-ledger`, `deploy`), so a tenant repository needs none of this repository's scripts.

```bash
pnpm hearthlog plan --site jst            # read-only: resources, steps, problems
pnpm hearthlog apply --site jst --yes     # changes Cloudflare
```

## Plan

`hearthlog plan` needs no credentials. It prints the Workers, buckets, Ledger
application, and Access application the tenant would own, which of them hold
data (never deleted), the billable classes, the steps in order, and any
**problems**. A problem stops `apply`:

- a dedicated tenant's bucket, Worker, or Ledger name is also used by another
  tenant or by the shared stack (its gateway would reach their data);
- a name does not start with the tenant's resource prefix;
- no Access team or no allowed user (the site would be deployed unprotected).

A tenant on the shared stack is declared to share it, so shared names are not a
problem for it. A missing `accountId` is only a warning.

## Apply

Steps run in order, each through an existing idempotent tool:

| Step | Runs | Does |
| --- | --- | --- |
| `resources` | `hearthlog ensure --skip-ledger --skip-secrets` | buckets, Access application |
| `ledger` (own stack only) | `hearthlog deploy-ledger --site <id>` | deploys the tenant's Ledger; the first run adds `--bootstrap-secrets` (administrator token and signing key, kept in `.wrangler/tenants/<id>/`) |
| `ledger-app` | `hearthlog ensure` | registers the Ledger application with the site's event policy and gives the gateway its token; an existing application keeps its token and policy |
| `frontend` | `hearthlog deploy` | builds and deploys the gateway and public Workers |
| `verify` | an HTTP request | the origin must send a visitor to sign in, never serve the app |

`apply` also takes `--skip-build` (deploy the build already in place, as the tenant workflow does after its build job),
`--dry-run` (the tools' dry runs; no receipt), and `--no-bootstrap` (refuse to create a token or signing key; implied in CI).
See [the tenant workflow](github-deployment.md#tenant-workflow-a-site-on-its-own-stack).

Nothing in `apply` deletes a bucket, a Ledger, or an Access application, it
never passes `--rotate-token`, and it only reads account-wide Access settings.

Each finished step is written to `.wrangler/tenants/<id>/receipt.json`: the
resources, the modules, and a timestamp per step. It holds no secret (the
serializer refuses keys shaped like one) and is local, gitignored state. If
`apply` stops, run the same command again: finished steps are skipped, so the
administrator token and the application's token are minted once. A receipt for
different resources than the plan names is refused; delete it only when you
mean to start over.

## Event policy

A new Ledger application starts with a policy that accepts the core's events and
those of the modules the site ships, refuses runtime-defined entity types unless
the site enables them, and rejects violations. See `packages/ledger/README.md`. To enforce
the same on an application that already exists:

```bash
pnpm ensure:tenant -- --site <id> --apply-policy
```

## Account values

Nothing in the code names an account. The shared values are operator input in
`tenants.json` (`infrastructure.workersDevDomain`, `accessTeamDomain`,
`invoiceRendererOrigin`); a tenant in its own account overrides them in its
`deployment.json` (`workersDevDomain`, `authentication`, `ledgerAdminEmail`,
`invoiceRendererOrigin`, `kalApiOrigin`, and the session lengths; a repository
with no `tenants.json` needs the first three there) and, with `accountId`, pins its generated Worker configs to
that account. Secrets come from the environment (`CLOUDFLARE_API_TOKEN`,
`INVOICE_RENDERER_TOKEN`, `INVOICE_EXTRACTION_*`), never from a lookup the repository
knows about.

## Moving a site into its own repository

A site on its own stack becomes a repository of its own with one command; it creates no repository and touches no remote:

```bash
pnpm tenant:export -- <id> --out ../<id>      # or: hearthlog export <id> --out <dir>
```

The directory holds what `hearthlog init` writes (package.json, Vite and TypeScript configuration, pnpm settings, a
deploy workflow without path filters, `.gitignore`, a short README) and the site's `tenants/<id>/` (`tenant.json`,
`deployment.json`, `modules.lock.json`, `static/`). The shared values the site read from `tenants.json` are written
into the exported files: the account values (workers.dev domain, Access team, administrator email, renderer and
food-catalog origins, session lengths) into `deployment.json`, and the `defaults` it relied on (features, home, title,
navigation flags) into `tenant.json`; there is no `tenants.json`, and the Gallery sweeper is dropped. Nothing from
`.wrangler/` is copied (token files, receipts), nor `resign.local.json`. Dependencies are `^<version>` ranges; the
lockfile is written by the first install once the packages are published. A site on the shared stack is refused.
`pnpm check:tarballs jst delta bravo st` builds each site from its exported directory and requires `hearthlog plan` there
to equal the plan from this repository.
