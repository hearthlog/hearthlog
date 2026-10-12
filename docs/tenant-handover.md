# Handing a site over to its own repository

`pnpm tenant:handover -- <id> --out ../hearthlog-tenant-<id>` runs steps 1 to 4 and the first commit and push audit below (`--push` also
creates the private repository and pushes; `--rehearse` runs against locally packed packages and commits nothing).

A site on its own stack ([splitting a tenant](deploying-a-tenant.md)) can live in a repository of its own, which then
builds and deploys it. This is the order, with the gate before the first deploy. Everything that changes a remote is
yours to do; the tools below read and build.

1. **Export.** `pnpm tenant:export -- <id> --out ../hearthlog-tenant-<id>`. The directory is `hearthlog init`'s starter plus the
   site's `tenants/<id>/`, with the shared account values written into it; nothing from `.wrangler/` is copied. It needs the
   platform and the site's modules on npm (the dependencies are `^` ranges and there is no lockfile yet).
2. **Install and build there.** `pnpm install` writes the lockfile (commit it); `pnpm build`.
3. **Gate 1: the plan is a no-op.** `pnpm hearthlog plan --site <id>` in the new repository must list the same resources,
   steps and problems as in the old one (`check:tarballs` proves this for the exported starter).
4. **Gate 2: the build is the same site.** Build the site in the old checkout (`VITE_STOR_TENANT=<id> pnpm build`), then in the new
   repository run `pnpm hearthlog artifact compare --site <id> --against <old checkout>`. Routes, chunk names without hashes, the
   offline precache list, the gateway table, the Ledger event contracts and the Worker configuration must be equal; how many
   files agree byte for byte is printed and does not matter. In the old checkout, `pnpm build:generated` restores the default site.
5. **Access, once, from your machine.** The Access application may not have been reconciled when the stack was split
   (`--skip-access`). With `CLOUDFLARE_API_TOKEN` exported, `pnpm hearthlog apply --site <id> --dry-run`, then the Access-only
   step, so the first deploy from CI finds nothing to change. To run `hearthlog` against the stack from the new checkout,
   copy the site's `.wrangler/tenants/<id>/` token files into its `.wrangler/` (they are never exported or committed).
6. **Push and set up.** Push to the empty private repository; create the protected `<id>` environment (required reviewer,
   branch `main`) with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `LEDGER_ADMIN_TOKEN` (from
   `.wrangler/tenants/<id>/.admin-token`); run the deploy workflow and approve it.
7. **Hand over for good.** In the old repository, delete `.github/workflows/<id>-deploy.yml` in the same commit that records the
   move, so a push there cannot deploy the site; use the site for a few days before moving the next one.

Two repositories must never deploy the same stack: until step 7 is committed, do not push the old repository.

## Adopting releases afterwards

A tenant repository follows the platform and its modules through its lockfile:

- `.github/dependabot.yml` (written by `hearthlog init` and `hearthlog export`) opens a weekly pull request that groups the
  `@hearthlog/*` bumps. By hand, `pnpm update "@hearthlog/*" --no-save` takes the newest releases the ranges in `package.json` allow and
  changes `pnpm-lock.yaml` only.
- The pull request runs the workflow's `build` job (it builds the site, checks the module lock with `hearthlog lock --check`, and prints the
  plan); the `deploy` job runs only on `main`, after the environment's approval.
- `tenants/<id>/modules.lock.json` names the modules a site ships and the hash of each manifest, not versions. A release that keeps a
  module's manifest changes nothing in it. A release that moves the contract (a new feature, route or entity) fails `lock --check` until
  `pnpm exec hearthlog lock` rewrites the file, and the diff of that file names the module.
