# Workspace release coordinator

The coordinator joins the existing core Release, module tag releases, and site
deploy workflows. It is optional and lives in `scripts/release/`; it introduces no
runtime dependencies or service. Node.js 24+, Git, pnpm, and authenticated `gh` are
required. Individual repositories retain ownership of their publishing and
deployment credentials and approvals.

Create an inventory **outside the platform repository**, alongside your checkouts:

```json
{
  "core": { "path": "platform", "repo": "your-org/platform", "branch": "main" },
  "modules": {
    "photos": { "path": "module-photos", "repo": "your-org/module-photos" }
  },
  "tenants": {
    "personal": { "path": "site-personal", "repo": "your-org/site-personal", "site": "personal" }
  }
}
```

`path` is relative to the inventory file. `repo` is `owner/repository` on GitHub.
`branch` defaults to `main`; `site` defaults to the tenant alias. Module aliases
are command arguments; package names come from their manifests. All installed
first-party modules must be configured, including private ones. Keep private
inventory outside the public repository. The coordinator clones through `gh`,
does not copy local credentials into its checkouts, and uses your existing package
registry configuration. Configure Git author identity before executing.

```sh
node platform/scripts/release/release.mjs --config release.config.json \
  core 0.2.0 --tenant personal

node platform/scripts/release/release.mjs --config release.config.json \
  module photos 1.1.0 --tenant personal --execute

node platform/scripts/release/release.mjs --config release.config.json \
  tenant personal --core 0.2.0 --module photos@1.1.0 --execute --merge
```

Omit `--execute` for a local preview. `core <version>` publishes core and releases
modules whose platform dependency ranges must change. Repeat `--module alias@version`
to choose release versions instead of automatic patches. `module <alias> <version>`
publishes that module and updates the tenant. Optional `--core <version>` selects an
already published core for module releases. `tenant <id>` only adopts already
published versions and requires `--core` and/or `--module`. Stable `x.y.z` versions
are required. Unspecified modules keep the tenant's locked versions. Core packages
are aligned and pinned together; the generated package's local link is preserved.

The existing release workflows must be named `release.yml` and the site workflow
`deploy.yml`. Sites need the standard `hearthlog`, Vite, module-lock, artifact, and
deployment-receipt contracts. A `check` script runs if present. Gallery's public
Worker is built when that module is enabled. Existing top-level pnpm `overrides`
in validation checkouts require explicit reconciliation; they are never silently
replaced. No new module or feature is enabled by the coordinator.

For a known configuration change, a tenant entry can declare `migrations`:

```json
{
  "whenCore": ">=0.2.0",
  "file": "tenants/personal/deployment.json",
  "from": ["legacyStorageEndpoint"],
  "to": ["moduleSettings", "org.example.photos", "endpoint"]
}
```

These explicit JSON key moves preserve the existing value, run in candidate and
published-package validation, and are included in the tenant PR. They are
idempotent and refuse conflicting destination values. Only tenant/deployment JSON
and `tenants.json` inside the checkout can be edited. Nothing infers configuration
renames or reads secrets. `whenCore` limits a migration to the intended core range.

## Sequence and validation

1. Snapshot remote branches in isolated clones. Save the request and immutable
   source SHAs in `.releases/<request-hash>/state.json` beside the inventory.
2. For a core release, run core checks and pack all core packages with the proposed
   version. For a module release, pack the proposed module. Test module sources
   in isolated composed sites against the exact candidate core (or chosen published
   core), including their unit tests. Test every installed module for core changes.
3. Build the complete tenant using candidate core/module overrides and its existing
   published versions for unchanged modules. Generate locks, run its type check,
   build public Workers/frontend, read the deploy plan, and seal/verify artifacts.
4. Dispatch the core Release workflow with `version`, `release_id`, and
   `expected_sha`. It refuses a source commit different from the validated one.
   Wait for the exact correlated run and all published core packages.
5. Commit required module package/manifest/lock changes on release branches, open
   PRs, and stop for merge. `--merge` waits for checks and merges using
   `--match-head-commit`; branch rules and merge queues are respected. Tag only
   the exact validated merged tree. Wait for tag-triggered publishing and registry
   availability. Public npm and private GitHub Packages remain separate.
6. Refresh tenant dependencies and locks from published packages, validate again,
   and open one tenant PR. After merge, wait for that exact commit's deploy run
   and download its `receipt` artifact. An unchanged tenant requires no deployment.

Compatible modules need no version bump. For an incompatible platform dependency
range, the coordinator appends `|| <exact-tested-version>`, preserving the old
supported range without promising compatibility with untested future releases.
It updates all declared platform dependencies, peers, and development dependencies,
not only SDK. The implementation supports stable exact versions, numeric
comparators, caret, tilde, `*`, and `||`; unsupported range syntax fails explicitly.
It does not infer source fixes or change manifest module API/projection versions.

Installed core versions and each module's core dependency/peer ranges are checked
explicitly before site validation. Third-party peer warnings remain warnings, as
in the existing workflows; builds, type checks, and unit tests still have to pass.

The core source tests use candidate source; unchanged module source tests use the
configured remote module branch. The complete candidate tenant additionally tests
the unchanged modules' **actual locked published packages**, so unpublished module
branch changes cannot silently enter the tenant. Existing core integration CI
still runs separately.

## Resuming

Repeat the same request and inventory with `--execute`. You can add `--merge` to
continue automatically. Completed stages, source snapshots, PR URLs and Actions
run IDs are retained. The coordinator never force-pushes, replaces tags, or silently
retries failed Actions jobs. Use GitHub's rerun control or explicitly add
`--retry-failed`. Missing packages are polled for up to ten minutes; registry/auth
errors stop. Workflow discovery is bounded to five minutes and waiting to two
hours. Environment approval remains in GitHub.

State writes are atomic. A workspace lock prevents overlapping commands and can
recover from a dead process on the same host. Do not share a running state directory
between hosts. A dispatch intent is saved before the network operation: if its
response is lost, resume looks for that same correlated run and never redispatches.
If no run exists, inspect Actions before archiving the abandoned state and starting
again. This deliberate stop prevents duplicate core publication.

To take fresh snapshots after a source fix, archive the stopped run's printed state
directory and start again. Check remote PRs/tags/runs first. Choose new versions if
any package was already published. Do not remove state while a release is running.
Keep `.releases/` out of Git; it contains scratch installs, plans, commits, and receipts,
and no token should be entered in the inventory. Exit `2` means waiting for a PR or
workflow; `1` means failure; `0` means complete or preview.

## Development

```sh
pnpm test:release
```

Tests use temporary fixtures and injected process runners. They do not publish,
push, dispatch workflows, or deploy. The site workflow remains responsible for
production verification; a local coordinator test cannot establish production
acceptance. GitHub CLI contracts used here are documented under
[workflow run](https://cli.github.com/manual/gh_workflow_run),
[run list](https://cli.github.com/manual/gh_run_list), and
[PR merge](https://cli.github.com/manual/gh_pr_merge).
