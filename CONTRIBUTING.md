# Contributing

Thanks for helping. A few things keep the project coherent.

- **Read `AGENTS.md`.** It is the source of truth for conventions, architecture invariants, and the
  checks a change must pass (`pnpm check:all`, plus the area-specific checks listed there).
- **Keep changes small and surgical.** Do not refactor or reformat code your change does not need.
- **Modules** live in their own repositories and reach the app only through `@hearthlog/sdk`. A change a
  module needs from the platform is an SDK export here; `pnpm check:modules` enforces the boundary.
- **Tests stay few**: add one for data integrity, access, or money rounding, and a journey for a new
  core flow. See the Tests section of `AGENTS.md`.
- **Commits** follow Conventional Commits (`feat(scope): …`, `fix(scope): …`).
- **Personal data and secrets** never belong in the repository. CI runs gitleaks over the tree and its
  history; `pnpm audit:push -- <directory>` checks a directory against your forbidden-identities list.

By contributing you agree that your contribution is licensed under the AGPL-3.0-only, like the rest
of the project.
