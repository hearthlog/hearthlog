# Copying a tenant onto its own stack

This runbook creates **jst**, a copy of **alpha** at its own address with its own
Ledger, buckets, public Workers, and Access application, in the same Cloudflare
account. alpha is only read: its Ledger, buckets, Access application, and devices
do not change, and it keeps working. After the copy both tenants take writes and
drift apart; nothing is merged back. The design is in
the modular platform plan.

## What makes a site run on its own stack

`tenants/<id>/deployment.json` next to the site's entry in `tenants.json`:

```json
{ "schemaVersion": 1, "resourcePrefix": "jst-prod", "ledger": "dedicated" }
```

The file may also name the account it lives in, so a site can run in an account
other than the shared stack's:

```json
{
  "schemaVersion": 1, "resourcePrefix": "jst-prod", "ledger": "dedicated",
  "accountId": "<32-character account id>",
  "workersDevDomain": "your-subdomain.workers.dev",
  "authentication": { "provider": "cloudflare-access", "teamDomain": "https://your-team.cloudflareaccess.com" }
}
```

`workersDevDomain` and `authentication.teamDomain` replace the shared
infrastructure's for this site only (hostnames, public Worker origins, and the
Access team its Workers trust follow them). The shared values themselves are
operator input in `tenants.json` (`infrastructure.workersDevDomain`,
`infrastructure.accessTeamDomain`); nothing in the code names an account.

A site may keep its definition next to its deployment file: `tenants/<id>/tenant.json`
(`schemaVersion: 1` plus the fields of a `sites` entry) is read like a `sites`
entry, and naming a site in both places is an error. `tenants/<id>/modules.lock.json`
records the modules a site ships and each manifest's hash; `pnpm lock:modules`
writes it for every site and `pnpm check:tenants` fails when it is stale.

Every resource name derives from the prefix: `jst-prod-ledger`,
`jst-prod-invoice-pdfs`, `jst-prod-calendar-feeds`, `jst-prod-gallery-files`,
`jst-prod-gallery-public`, and the `jst-prod-gallery-public` and
`jst-prod-calendar-public` Workers. `pnpm check:tenants` rejects a name the shared
stack or another site already uses. 

The site's frontend binds only those resources and runs its own public Gallery
sweep. The shared calendar feed Worker leaves the site out. **CI does not deploy
it:** `pnpm list:sites` and an all-sites `pnpm ensure:tenant` skip it, because CI
does not hold its Ledger's administrator token. Deploy it from your machine with
the commands below, also after later code changes.

## What the copy keeps and changes

| Kept | Changed |
| --- | --- |
| Event IDs, entity IDs, versions, timestamps, payloads | New app ID and new log IDs (recorded in `mapping.json`) |
| Authors (`actor`) and action grouping | A hidden log is hidden again at copy time, so its hidden date is new |
| Fork lineage, pointing at the copied parent log | Invoice and Gallery file keys carry the new app and log IDs |
| Invoice originals and ISDOC files, Gallery originals and derivatives with their metadata | Gallery publications get jst's public address; alpha's links keep working |
| Gallery publications owned by alpha, with their public copies | Calendar feeds and step-ingest tokens are not copied: create new ones in jst |

The generated-invoice PDF cache is not copied; it rebuilds on demand. Everything
written to alpha after the export stays in alpha only.

## Before you start

- `pnpm exec wrangler login` with an account that can deploy Workers and create R2 buckets.
- `CLOUDFLARE_API_TOKEN` with the Access permissions listed in `packages/tooling/src/deploy/ensure-tenant.ts`.
- The shared Ledger's administrator token in `LEDGER_ADMIN_TOKEN` (or `.wrangler/tenants/.admin-token`): the copy reads alpha through the administrator API, so alpha's own token is never needed or rotated.
- Optional: `gcloud` access to the invoice renderer secret, or `INVOICE_RENDERER_TOKEN`.

Each step below changes Cloudflare. Run them in order; every step can be repeated
safely except where noted.

## Steps

1. **Buckets and Access.** Creates the four `jst-prod-*` buckets and the Access application for `https://jst.example.workers.dev` with alpha's users. Account-wide Access settings, including the team-wide SSO lifetime, are untouched, so the token needs no organization permission for this site.

   ```bash
   pnpm ensure:tenant -- --site jst --skip-ledger --skip-secrets
   ```

2. **jst's Ledger.** Deploys `jst-prod-ledger`, generates its administrator token and token-signing key, pushes them as secrets, and keeps the administrator token in `.wrangler/tenants/jst/.admin-token` (back it up; it cannot be read from Cloudflare). Run `--bootstrap-secrets` **once**: it refuses when that file exists, because a new signing key would invalidate every app token. Later code deploys omit it.

   ```bash
   pnpm deploy:ledger -- --site jst --bootstrap-secrets
   ```

3. **Copy the history.** Exports alpha through the administrator API, restores it into jst's Ledger as a new app named `jst`, and checks every event page, fork lineage, and hidden state. It writes `.wrangler/tenant-copies/jst-<time>/mapping.json` (IDs only, no tokens). It stops when a fork is still being prepared; let it finish, or pass `--allow-skipped-forks` to copy without it.

   ```bash
   pnpm tenant:copy -- events --from alpha --to jst
   ```

4. **Copy the files.** Deploys the short-lived `jst-tenant-copy` Worker, bound to alpha's shared buckets and jst's buckets and reachable only with a random token, copies invoice and Gallery files with rewritten keys, compares every object, writes `files-report.json`, and deletes the Worker. A repeat run skips objects that already match.

   ```bash
   pnpm tenant:copy -- files --from alpha --to jst --run .wrangler/tenant-copies/jst-<time>
   ```

5. **Give jst's gateway a token.** Mints the token of the copied `jst` app and pushes the frontend secrets.

   ```bash
   pnpm ensure:tenant -- --site jst --rotate-token
   ```

6. **Deploy jst.** Builds and deploys the frontend, then its public Gallery and calendar feed Workers.

   ```bash
   pnpm deploy:tenant -- --site jst
   ```

## Verify before using jst

- Sign in at `https://jst.example.workers.dev`; an email not in the site's list is refused.
- Every log is there with the same names, and the hidden ones are hidden; Log history shows the same actions and authors.
- Compare a few figures with alpha: a month's Finance balance, open invoice totals, the Gallery photo count, a Health day.
- Open an invoice PDF and a Gallery original.
- Sync and the live connection work (save something on one device, see it on another), and the app reloads offline.
- Optionally build a Mac app: `pnpm apple:mac jst`.

## After the copy

- **Step ingest:** add the integration to jst's entry in `tenants.json` with jst's log ID from `mapping.json`, then `pnpm ensure:tenant -- --site jst --create-integration-token iphone-steps`, set the printed `clientId`, and redeploy. Point the iPhone Shortcut at whichever tenant you use day to day.
- **Calendar feeds:** create them again in jst; subscribers add the new URLs.
- **Code updates:** CI keeps deploying the shared sites only; run `pnpm deploy:ledger -- --site jst` after Ledger changes and `pnpm deploy:tenant -- --site jst` after frontend changes.

## Redoing the copy

Before you start using jst, a redo goes into a fresh app: revoke the copied app
with jst's administrator token (`POST /admin/v1/apps/<id>/revoke` on
`https://jst-prod-ledger.example.workers.dev`), then repeat steps 3–5. The
revoked app's data and its copied files stay until you delete them. Once jst has
its own changes, `tenant:copy` refuses to copy into it.
