# Contributing

Thanks for helping. A few things keep the project coherent.

- **Read `AGENTS.md`.** It is the source of truth for conventions, architecture invariants, and the
  checks a change must pass (`pnpm check:all`, plus the area-specific checks listed there).
- **Keep changes small and surgical.** Do not refactor or reformat code your change does not need.
- **Modules** live in `modules/<name>/` and reach the app only through `@hearthlog/sdk`. See
  `docs/modules.md`. `pnpm check:modules` enforces the boundary.
- **Tests stay few**: add one for data integrity, access, or money rounding, and a journey for a new
  core flow. See `docs/testing-strategy.md`.
- **Commits** follow Conventional Commits (`feat(scope): …`, `fix(scope): …`).
- **Personal data and secrets** never belong in the repository. `pnpm audit:snapshot` checks for them.

By contributing you agree that your contribution is licensed under the AGPL-3.0-only, like the rest
of the project.
