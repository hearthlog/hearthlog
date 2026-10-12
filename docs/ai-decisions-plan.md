# AI decisions: implementation plan

Status, 3 October 2026: phases 1 to 4 are built; phase 0 is partly done and phase 5 is
not started. What is built is described in [ai-decisions.md](ai-decisions.md).
Still open before the first deploy: run `pnpm ai:eval` to confirm the model's
output shape and the 0.9 threshold on your own rows, and decide on a per-site
daily cap (AI Gateway rate limiting was not verified, so the free allocation
and the 50-item request cap are the only bounds). Deploy Ledger before the
frontend: schema v39 adds `category_source` and `expenseType` to its event
schemas.

This plan starts the AI work from the [design study](design-concepts/ai-2026-10-03/index.html)
with its cheapest and most useful part: a **decision API** backed by a small
decision model (Clef-flash on Workers AI), used first to **classify Finance
transactions** and then to set an **expense type on received invoices**.
Costs are estimated in [part 2](design-concepts/ai-2026-10-03/economics.html):
at `st` volumes this work fits inside the Workers AI free allowance.

## Decisions already made

| Question | Answer |
| --- | --- |
| Where transaction categories are suggested | Both: in the transaction drawer and in a "Sort uncategorized" review sheet |
| Category list | Keep the fixed list and add **Shopping**, **Leisure**, **Kids**, **Gifts and giving** |
| Invoice tags | One **expense type** per received invoice, from a fixed list in code; issued invoices are unchanged |
| Pre-ticking | Yes, at a fixed probability of **0.9** |
| History rule | Runs first: same name → same category as before, in SQL, with no model and no AI mark |
| Provider | Clef-flash through a Workers AI binding; Gemini stays for document reading only |
| Sites | `st` only, through an `ai` capability list in `tenants.json` |

## How a suggestion is shown

The same three bands apply everywhere:

| Source | Probability | UI |
| --- | --- | --- |
| History rule | — | Value filled or ticked, with a plain reason (“same as 14 earlier”), no AI mark |
| Decision model | ≥ 0.9 | Value filled or ticked, with the blue **Suggested** tag |
| Decision model | 0.5 – 0.9 | Shown as a suggestion chip, not applied |
| Decision model | < 0.5, or `none` | **Choose**: no suggestion |

A filled value is never saved by itself: the user's Save or Apply is the only
write. Editing a filled field removes its tag. When offline or without the
capability, the suggestion UI does not appear and the manual path is unchanged.

## Phase 0 · Spike and offline evaluation (no product change)

Goal: prove the model call works and is good enough before building UI.

1. Confirm Clef-flash's Workers AI model id, request shape (state + typed
   question + options) and response shape, and whether the 10 000-neuron daily
   free allocation covers it. Confirm the AI binding works under `wrangler dev`
   (it calls the remote service and counts against the account).
2. Write `scripts/ai-eval-categories.ts`: reads a local JSON export of
   `{ name, amount, category }` rows, sends the uncategorised-style question in
   batches, and prints precision and coverage at 0.9 and 0.5. Export the rows
   with a SQL query in Developer. **The export stays local** (gitignored path
   under `.eval/`); it contains personal finance data.
3. Go/no-go: at 0.9, precision ≥ 95 % on at least 100 rows the history rule
   would *not* have settled. If Clef-flash misses, try Clef (27B) through the
   same adapter before giving up.

Verification: `pnpm check:scripts`. No commit of data.

## Phase 1 · Decision API foundation

### Configuration

- `wrangler.jsonc`: add `"ai": { "binding": "AI" }` to the production and
  staging environments. Extend `BaseWranglerConfig` in
  `scripts/wrangler-config.ts` so generated site configs carry it.
- `tenants.json`: optional `ai: AiCapability[]` per site (defaults to none).
  Validate ids in `scripts/tenant-config.ts`; `pnpm check:tenants` rejects
  unknown ids. Set `"ai": ["category-pick", "invoice-expense-type"]` on `st` only.
- Generate the list into the Worker as a var (`AI_CAPABILITIES`) and into the
  client tenant config next to `features`, so the UI can hide what's off.
- Shared pure module `src/lib/ai/capabilities.ts`: capability ids, input and
  output types, probability bands (`0.9`, `0.5`). No Svelte, no `$app`.

### Worker route

`POST /api/ai/v1/logs/{logId}/decisions/{capability}` in `worker/ai-decisions.ts`,
registered in `worker/index.ts`. It follows `received-invoice-extraction.ts`:

1. Same-origin check, `authorizeStorRequest`, `verifyLogAppId`.
2. Capability must be in `AI_CAPABILITIES`; otherwise `503 ai_unconfigured`,
   which the client treats as “hide the feature”.
3. Validate the body per capability: at most 50 items, short strings,
   finite numbers, JSON at most 64 KiB.
4. **The Worker builds the question and the options.** The browser sends data,
   never prompt text or option lists. Options come from the shared code lists
   (`src/lib/finance/categories.ts`, `src/lib/invoices/expense-types.ts`).
5. Call the model through one adapter, `worker/ai/decision-model.ts`
   (`decide(state, question, options) → probabilities`). This is the only file
   that knows about Clef. Swapping to Jev or Gemini changes only this file.
6. Validate the output: every option is in the list or `none`, and every
   probability is between 0 and 1. Return
   `{ model, decisions: [{ id, option, probability }] }`.
7. No inputs or outputs are logged; error messages are fixed strings.

Credentials: none. The binding authorises the call inside Cloudflare, so there
is no key in the Worker, the bundle or the browser.

Limits: per-request item cap and timeout in the route. A daily per-site cap
through AI Gateway rate limiting (with request logging off) is verified in
phase 0. If that doesn't work, the free allocation and the request cap are the
v1 bounds, and an abuse-proof counter waits for the reader work.

### Client and dev

- `src/lib/ai/decisions.ts`: typed fetch with `withTimeout`. Returns
  `unavailable` when offline, on `503`, or on timeout, so callers just skip
  suggestions.
- Vite dev: a plugin like `localInvoiceExtractionPlugin` answers `503`. With
  `VITE_E2E=1` it answers from a small deterministic table (fixture names →
  category, 0.95), so journeys stay hermetic.

### Tests and docs

- Vitest `worker/ai-decisions.test.ts` (access and data integrity): rejects a
  missing Access session, another site's log, a disabled capability, oversize
  bodies, and model output outside the option list.
- `docs/ai-decisions.md`: capabilities, what each sends, limits, opt-in.

Verification: `pnpm frontend:worker:check`, `pnpm frontend:worker:dry-run`
(binding change), `pnpm check:tenants`, `pnpm check:scripts`,
`pnpm test:scripts`, `pnpm check:ts`, `pnpm test:unit --run`.

## Phase 2 · Finance categories and the history rule (no AI yet)

These are useful on their own and give the model a baseline to beat.

1. `src/lib/finance/categories.ts`: add `shopping`, `leisure`, `kids`, `gifts`
   (label “Gifts and giving”) before `other`. Stored values are strings, so
   there's no migration, and existing transactions keep their category.
2. `src/lib/db/transactions.ts`: `categoryFromHistory(names)` in SQL.
   - Match on `lower(trim(name))`.
   - Count categorised rows only (not `unknown`).
   - Return the leading category, its count and its share.
   - Suggest only when count ≥ 2 and share ≥ 0.8.
   - Grouping and counting stay in SQL.
3. `uncategorizedInMonth(month)` and a count for the month header, in SQL.

Verification: `pnpm check:ts`, `pnpm test:unit --run`.

## Phase 3 · Transaction classification

### Drawer

When Name loses focus while Category is still Uncategorized and untouched:

1. Ask the history rule. On a hit, fill Category and show “same as N earlier”.
2. Otherwise, if online and `category-pick` is on, send `{ name, amount, sign }`.
   At ≥ 0.9, fill Category with the **Suggested** tag. Between 0.5 and 0.9, show
   a chip under the field; one tap fills it.
3. Ignore any answer that arrives after the user has touched Category or closed
   the drawer.

### Sort uncategorized

- **Entry point:** a secondary month action, “Sort N uncategorized”, shown only
  when N > 0. It isn't a navigation badge, because uncategorised isn't late work.
- **The sheet:** a `CommandDrawer` listing the month's uncategorised rows. The
  history rule runs first, then the remaining rows go to the decision API in
  batches of up to 50. Rows are ticked or shown with a chip per the bands above.
- **Apply:** one multi-event `executeLocalCommand([...], { submissionId })`
  for the ticked rows, then `refreshPageData` and `notify.success` with
  **Undo**. Undo is a second multi-event action that restores the previous
  values.
- **While saving:** the sheet is disabled while busy, and a failure keeps the
  ticks and shows an inline `role="alert"`.

### Provenance

Add an optional `category_source` field to `transaction`
(`manual | history | ai:<model>`, `optionalInPayload`) in
`entity-definitions.ts`, run `pnpm generate:entities`, bump `SCHEMA_VERSION` to
39 and check the repair path. This lets SQL later measure how often
suggestions were kept, which is the evidence for lowering or raising 0.9.

### Tests

- A projection test for `category_source` (data integrity).
- Extend the Finance journey: an uncategorised fixture row, then Sort, Apply
  and Undo, using the E2E stub.

Verification: `pnpm check:ts`, `pnpm test:unit --run`, `pnpm build`,
`pnpm test`, `pnpm generate:entities:check`.

## Phase 4 · Expense type on received invoices

1. `src/lib/invoices/expense-types.ts`, in this order:
   Services, Goods and materials, Software and subscriptions, Equipment,
   Telecom and internet, Rent and energy, Travel, Marketing, Education,
   Insurance, Taxes and fees, Other. The value `''` means not set.
2. Add a `expense_type` field to `received_invoice` (string, default `''`,
   `optionalInPayload`). Regenerate, bump `SCHEMA_VERSION`, and include it in
   the same version bump if it ships together with phase 3.
3. UI: a `Select` in the received drawer and details pane, a list filter by
   type (URL param in `src/lib/invoices/url.ts`, `WHERE` in
   `src/lib/db/invoice-list.ts`) and a column.
4. History rule: same supplier IČO, else the normalised supplier name, sets
   the last type used. SQL only.
5. Capability `invoice-expense-type`. It sends the supplier name, the
   description and up to 10 line-item descriptions. It never sends the PDF,
   bank details or amounts.
   - After an import or a manual edit, the drawer fills at ≥ 0.9.
   - A “Type N invoices” sheet covers the backlog, reusing the Finance sheet
     component. Generalise it to `DecisionReviewSheet` at this point, not
     earlier.
6. Later: spending by expense type in the invoices analytics, as a SQL
   `GROUP BY`.

Verification: as phase 3, plus the invoices journey for one typed import.

## Phase 5 · Next decisions, once phases 3 and 4 are used

These come in order of value:

1. **“Paid by”** on invoices: SQL candidates plus `none`. A wrong pick marks an
   invoice paid, so consider 0.95 here.
2. A quick check that a photo is readable, before paid reads.
3. Gallery tags and sorting out screenshots.
4. Food, party and calendar feed duplicates.

Each one is a new capability id, an options list, and a call site. The route
and adapter stay unchanged.

## Rollout

1. Phases 1 and 2 ship together and change nothing visible except the four new
   categories.
2. Deploying is your step. After each deploy to `st` staging, a week of use,
   then production.
3. After a month, query `category_source` and the overrides. If kept
   suggestions at ≥ 0.9 are under 95 %, raise the threshold. If they're near
   100 %, try 0.85.

## Still to confirm in phase 0

- Clef-flash model id, payload format, and how `none` or abstain is expressed.
- Free-allocation treatment of Clef and the actual neuron cost per call.
- AI Gateway rate limiting for a Workers AI binding, with logging disabled.
- Whether one request can carry 50 decisions, or batching means 50 calls.
