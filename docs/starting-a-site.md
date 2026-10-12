# Starting a site

A Hearthlog site is a small folder: it says which modules it ships, and the build writes everything else.

```bash
pnpm hearthlog init my-site --id my-site --modules calc,health    # package names or short names; `none` for the core only
cd my-site && pnpm install && pnpm dev
```

`init` renders `packages/tooling/templates/tenant/`:

| File | What it is |
| --- | --- |
| `package.json` | The `@hearthlog` packages and the modules, plus the Vite-side packages the configuration imports and `sqlocal` (the list is the tooling package's `peerDependencies`; the site must declare them because the server build resolves them from the site) |
| `vite.config.ts`, `tsconfig.json` | Three lines and a small file; the configuration is `hearthlogConfig()` in `@hearthlog/tooling` |
| `tenants.json` | Placeholder infrastructure names: enough to load, not to deploy. Optional: a site with its own `deployment.json` needs none |
| `tenants/<id>/tenant.json`, `modules.lock.json` | What the site enables, and the modules it ships with the manifest each was composed from |
| `.github/workflows/deploy.yml` | The tenant's deploy workflow: a build job with no secrets, then a deploy job in a protected environment named after the site (see [GitHub deployment](github-deployment.md#tenant-workflow-a-site-on-its-own-stack)) |
| `pnpm-workspace.yaml`, `patches/` | The build scripts pnpm may run (esbuild, Tailwind) and the patch to `sqlocal`, which does not travel with a dependency; `package.json` pins pnpm like this repository does |
| `.generated/package.json` | The only committed file in `.generated/`, which `hearthlog build` fills (the module catalog, entity code, routes, service worker, static files, the gateway entry) |

Add a module by listing its package in `package.json`, adding its features to `tenant.json`, and running `pnpm lock:modules`.
A site's own pages go in `src/routes/` and are merged into the generated routes (a path that collides with a core or
module route is an error).

`examples/empty` (the core only) and `examples/calc-only` are committed `init --workspace` output. `pnpm check:examples`
fails when either differs from the template (CI runs it), and `pnpm examples:update` brings them back in line. They are not
members of the workspace and are not built here: the workspace packages share one `.generated/`, so a build here would
use the `st` catalog whatever the site. Their build, and the check that the empty one ships no module code, run against
installed packages outside the workspace: `pnpm check:tarballs` packs every package, installs each site from the
tarballs with a frozen lockfile, builds it, and compares a tenant of this repository (`jst`) with its workspace build
(routes, chunks, precache list, gateway table, Ledger contracts). It takes a few minutes and is run by hand.

For a Mac or iPhone app of the site, add `@hearthlog/native` to the dependencies and run `pnpm exec hearthlog apple:mac <site>` (see `docs/native-shell.md`); the site template already git-ignores `.apple-build/` and `resign.local.json`.
