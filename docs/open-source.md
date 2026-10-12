# Publishing the platform

The platform is AGPL-3.0-only. The public repository starts from a reviewed **snapshot** of this
one, with no history, so nothing personal that was ever committed here can reach it. This page
is the procedure and its limits. Nothing in it publishes anything by itself.

## What the snapshot contains

`pnpm snapshot -- --out ../hearthlog-public [--commit]` takes the tracked files of the **last commit** (never the working
tree) and writes the public repository's content, a **platform workspace** with no site of its own:

- every file except the **operator-only** paths in `scripts/snapshot-policy.json`: design screenshots made from real
  data, performance captures, local Apple signing settings, every workflow of this repository, `modules/`, `tenants/`,
  `tenants.json`, the Ledger admin console, the module journeys, the plans and histories that narrate the operator's
  own sites, and the snapshot tools themselves;
- `scripts/public-overlay/` laid over the copy: a module-less `st` site, the public workflows (`ci.yml`, the tag-driven
  `release.yml`), the unit-test configuration, and `.generated/package.json`; the root `package.json` loses the
  `module-*` dependencies and the operator's scripts;
- the ids of the operator's own sites replaced by neutral words (`neutralIds`), and links to left-out documents turned
  into plain text;
- a lockfile for the snapshot's own workspace (`pnpm install --lockfile-only`: the versions stay, the modules go);
- `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`.

It then runs the personal-data audit on the result and exits non-zero while anything is left. With `--commit` it makes
the first commit in the directory (branch `main`, this repository's git identity). It creates no remote, pushes
nothing, and publishes nothing; a report named after the directory (`<dir>.report.json`) lists the commit, the counts,
and the binary and image files you must look at yourself.

A snapshot stands on its own: installed from its lockfile, it type-checks, passes the unit and script tests it keeps,
the Ledger tests and the calendar journey, builds, dry-runs the Workers, and builds the empty example from tarballs.
Tests that need installed modules stay in this repository (see the split plan).

## The personal-data audit

`pnpm audit:snapshot` runs on the repository itself. It reports email addresses, workers.dev,
Access, and Cloud Run hosts, project-id lookalikes, and the exact names your own configuration and
git identity contain, in every file that would be public (after redaction for the configuration
files). Keep it at zero: the usual fix is a placeholder (`owner@example.com`,
`example.workers.dev`) or moving the value into `tenants.json`.

The audit cannot read images. Review the files listed under `review` in the report: icons, logos,
and any screenshot. Also read the git identity you will publish under, the package names, and the
site ids in `tenants.json` (`bravo`, `delta`, …), which are kept as example tenants.

## Forbidden identities and the push gate

Some values must never reach a public repository: work addresses, an employer's or company's name,
tax and account numbers. They cannot be listed in this repository, because the list would leak
them. They live in `~/.config/hearthlog/forbidden.json` (or `$HEARTHLOG_FORBIDDEN_FILE`):

```json
{ "forbidden": ["strings matched case-insensitively anywhere"], "allowedAuthorEmails": ["the personal address"] }
```

- `pnpm audit:forbidden:init` writes a first list from the identities in this repository's git
  history (every address except yours, GitHub and tool `noreply` addresses, and bots, plus the name
  of each non-free-mail domain). Add what history cannot know with `--add <string>`. Open the file to
  review it; nothing is printed from it.
- `pnpm audit:snapshot` and `pnpm snapshot` **refuse to run without the file**. They search file
  names, file contents, and the raw bytes of images and other binary files for every entry.
- `pnpm audit:push -- <directory>` is the gate before a push. Run it on the exact directory: the
  snapshot with its first commit made, or a module clone. It repeats the file checks, and for git
  history it requires every author and committer to be one of `allowedAuthorEmails` (GitHub's own
  `noreply` addresses are accepted), searches commit messages, tags, branch names, and every commit's
  diff (so a value committed and later deleted still fails), and checks the repository's own
  `user.email`.
- Reports and errors never print a value from the list: findings name it by entry number, and file
  names that contain one are masked.

## Before you publish

These are decisions and actions that are yours:

1. **The project and npm scope name.** Decided: `hearthlog` / `@hearthlog`. The GitHub and npm organizations exist; see the repository split plan.
2. **The license text.** `LICENSE` holds the SPDX text of the AGPL-3.0; replace it with the file from
   gnu.org if you want the FSF's exact layout.
3. **Outside-module licensing**: whether a module bundled into an AGPL app must itself be
   AGPL-compatible, or the project grants a linking exception. Needed before an outside module is
   promoted.
4. **Review the snapshot directory** and its report; read the images.
5. **Run the gate.** `pnpm snapshot -- --out <directory> --commit` makes the first commit; then run
   `pnpm audit:push -- <directory>`. Push only when it reports 0 findings. Module repositories come from
   `pnpm module:export -- <name> --out <dir>`.

## What is not built yet

Published packages (`@hearthlog/contracts`, `ui`, `runtime`, `shell`, `ledger`, `cloudflare`,
`tooling`) and the host template that `hearthlog build` would generate (plan, step 7.1) are not built,
so module repositories cannot yet run CI against a platform range or be adopted by a lockfile
change alone, and this repository cannot yet drop platform source (step 7.5). The SDK reaches 169
files of the app (components 47, store 18, db 15, event 13, ledger 11, runtime 11, and a long
tail); moving them and the host shell into packages, and rewriting the `#lib` imports, is the
work of 7.1.
