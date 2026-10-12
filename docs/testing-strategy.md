# Test portfolio

Tests stay few. The unit suite (`pnpm test:unit`, about 100 tests) covers only
what protects data, access, and money:

- Data: commands and validation, projections and atomic rebuilds, schema
  migrations, tenant/log scoping, the outbox, sync convergence, history replay,
  local recovery, and the route refresh registry.
- Access: Access token verification, the credential-injecting gateway, route
  guards, and feature gating of commands.
- Money: invoice totals and decimal rounding.

Feature logic, formatting, parsing conveniences, and UI helpers get no unit
test. Add one only when a change touches the areas above.

The browser suites are deliberately small. Each journey proves that several
layers work together in a real browser: commands, local persistence,
projections, files, and offline delivery. None of them checks layout, copy, or
a rule a unit test can hold.

| Suite | Command | Journeys |
| --- | --- | --- |
| Default (`tests/*.spec.ts`, hermetic dev server) | `pnpm test` | Finance transaction add and edit; Calendar event create, pin, edit, and delete; invoice creation with PDF preview, device copy, and regeneration; received invoice kept offline and uploaded after reconnecting; Log history inspection and fork boundaries; Gallery offline import, viewer, and favorite; Health steps logged on a past day from the endless list, found again on the Health day |
| Production (`tests/production/`, built app) | `pnpm test:preview` | Every page renders without browser errors; the complete app installs for offline use |
| Worker (`tests/worker/`, `wrangler dev`) | `pnpm test:worker` | Ledger Worker protocol and admin console contracts |

Add a browser journey only for a new core workflow that depends on the browser
(files, offline, service worker, IndexedDB or OPFS) or on commands,
projections, and UI working together. Extend an existing journey before adding
a new one, keep at most one per feature, and move any rule it asserts into a
unit test first. Do not add browser tests for layout at a viewport width,
visual placement, or copy.

CI (`st-ci.yml`) runs the default suite in one job and builds the default site
for the production checks in another. `ledger-ci.yml` runs the Worker suite
when `ledger/` changes. `deploy.yml` builds every site before it deploys.

## Tests that need modules

This repository installs no module: its `st` site has none, so `pnpm test:unit` skips the tests that depend on a module's entities and
routes (route access, entity scope, module projections, sync invalidation, sync convergence). `pnpm test:integration` runs them, with the type
check, the frontend Worker's `Env` declaration check and the Ledger's tests, against the published modules: it installs `@hearthlog/module-*`
from npm for the run, swaps the development site for `integration/st.tenant.json` (every module's features), locks the modules, and puts
`package.json`, the lockfile and the site back afterwards. CI runs it as its own job. A module's own behaviour is tested in its own repository.
