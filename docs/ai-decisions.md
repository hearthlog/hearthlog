# AI decisions

Small questions with a fixed set of answers (a category, an expense type) go to
a decision model through the frontend Worker. The model returns a probability
for each option Hearthlog supplied, or `none`. It writes no prose, so it cannot
invent a value, and its answer is never saved by itself: the user's Save or
Apply is the only write. Reading documents stays with Gemini
([received-invoice extraction](received-invoice-extraction.md)).

The rollout plan and the reasons behind each choice are in
[ai-decisions-plan.md](ai-decisions-plan.md).

## Capabilities

| Id | Used for | Sends | Never sends |
| --- | --- | --- | --- |
| `category-pick` | Finance transaction category | name, absolute amount, income or expense | date, account, other rows |
| `invoice-expense-type` | Expense type of a received invoice | supplier name, description, up to 10 line item descriptions | the PDF, bank details, amounts |

A site enables capabilities with `ai` in `tenants.json` (`st` only for now).
`pnpm check:tenants` rejects unknown ids and keeps the Worker's
`AI_CAPABILITIES` variable and the generated client tenant module in step.
Every site's Worker config is generated, so its `AI_CAPABILITIES` always follows
`tenants.json`; `pnpm check:tenants` verifies the generated files.

## How a suggestion is shown

| Source | Probability | UI |
| --- | --- | --- |
| History rule | n/a | Value filled or ticked with a plain reason ("Same as 14 earlier"), no AI mark |
| Decision model | 0.9 or more | Value filled or ticked with the blue **Suggested** tag |
| Decision model | 0.5 to 0.9 | A suggestion chip; one tap fills it |
| Decision model | under 0.5, or `none` | **Choose**, no suggestion |

The bands live in `packages/contracts/src/ai/capabilities.ts` (`AUTO_APPLY_PROBABILITY`,
`OFFER_PROBABILITY`). The **history rule** runs first, in SQL, with no model:
the same name (case and surrounding spaces ignored) leads to the category it
was given before, when at least 2 categorised rows agree and they hold at least
80 % of the categorised rows of that name. Editing a filled field removes its
tag. When offline, or on a site without the capability, no AI suggestion
appears and the manual path is unchanged.

## Where they appear

- **Transaction drawer** (`category-pick`): about 0.7 s after typing in Name or
  Amount pauses (or at once when the field loses focus), while Category is still
  Uncategorized and untouched, the history rule answers first, then the model. An answer that arrives after Category was touched, or
  the drawer closed, is dropped.
  A **Suggest** button (sparkle icon) beside the Category label asks on demand,
  even after you touched the field, and says "No suggestion for this name." or
  "Suggestions aren't available right now." instead of staying silent.
- **Sort uncategorized** (`category-pick`): a month action on Finance, shown
  only when the month in view has uncategorised rows. A review sheet ticks
  history matches and confident picks, offers the rest as chips, and Apply
  writes the ticked rows in one multi-event action with Undo. The sheet is
  `DecisionReviewSheet` (`packages/shell/src/components/ai/`), shared with the invoice
  sheet.
- **Received invoice drawer** (`invoice-expense-type`): after a PDF or ISDOC
  import, about 0.7 s after typing in Supplier or Description pauses, and when
  either loses focus, while Expense type is
  empty and untouched. The details pane shows the type, the list has a Type
  column and an Expense type filter (`type` in the URL; `unset` matches
  invoices without one). A **Suggest** button beside Expense type asks on demand.
- **Type invoices**: a toolbar action on the received list, shown only when
  invoices lack a type, for the backlog. The history rule here is the type last
  used for the same supplier: the IČO decides when there is one, otherwise the
  supplier name (SQL in `expenseTypeFromHistory`).

Issued invoices are unchanged. The expense types are a fixed list in code
(`modules/invoices/src/invoices/expense-types.ts`); an empty value means not set.

## Route

`POST /api/ai/v1/logs/{logId}/decisions/{capability}` with
`{ "items": [...] }`, in `packages/cloudflare/src/ai-decisions.ts`.

1. Same-origin check, Access identity and allow-list, and Ledger log
   verification, as for the other private Worker routes.
2. The capability must be in `AI_CAPABILITIES` and the `AI` binding present;
   otherwise `503 ai_unconfigured`, which the client treats as "hide the
   feature".
3. The body is JSON of at most 64 KiB with 1 to 50 items; strings are short,
   numbers finite, ids unique.
4. **The Worker builds the question and the options** from code
   (`packages/cloudflare/src/ai/decision-questions.ts`, `decisionOptions()` in
   `packages/contracts/src/ai/capabilities.ts`). The browser sends data, never prompt text or
   option lists. Item text is quoted into the model's state, and the answer can
   only be one of the options, so text that looks like an instruction cannot
   change the result.
5. `packages/cloudflare/src/ai/decision-model.ts` is the only file that knows which model
   answers: `@cf/cloudflare/clef-flash` through the Workers AI binding, one
   `choice` question per item, `none` always offered. Swapping the provider
   changes that file only.
6. Every answer is validated: the option must be offered or `none`, and the
   probability must be between 0 and 1. Anything else is `502 ai_failed`.
7. Inputs and outputs are not logged and error messages are fixed strings.

There is no credential: the binding authorises the call inside Cloudflare, so
nothing exists in the Worker, the bundle or the browser to leak. `wrangler dev`
with the binding calls the remote service and counts against the account.

Limits: 50 items and 64 KiB per request, a 20 s deadline per request, and six
model calls in flight. The free allocation (10 000 neurons a day, shared with
any other Workers AI use on the account; Clef-flash is 8 182 neurons per million
input tokens) is the v1 spending bound. A per-site daily cap through AI Gateway
rate limiting is not built.

## Client and local development

`packages/runtime/src/ai/decisions.ts` calls the route and never throws: offline, a missing
capability, `503`, a timeout or an unusable answer return no decisions.

Vite dev has no AI binding, so the route answers `503` and the suggestion UI
stays hidden. With `VITE_E2E=1` it answers from a small table (fixture names to
a category or type at 0.95), so the browser journeys stay hermetic.

## Evaluating the model

`pnpm ai:eval -- --input .eval/categories.json` asks the Worker's question of
the model for a local export of `{ name, amount, category }` rows and prints
precision and coverage at 0.9 and 0.5, for every row and for the rows the
history rule would not have settled. The export is personal finance data: keep
it under `.eval/` (gitignored). Credentials are read from
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment only. Add
`--raw` to print the first raw model response.

Go/no-go: at 0.9, precision of at least 95 % on at least 100 unsettled rows.
The adapter reads the answer as a map of option to probability (also nested
under `probabilities` or `scores`) or a list of entries, because the model's
output schema is published only as a downloadable file. Confirm the shape with
`--raw` before the first deploy and adjust `readChoice` if it differs.

## Provenance

`transaction.category_source` is `manual`, `history` or `ai:<model>` (empty for
older rows), written with the category. SQL can then measure how often a
suggestion at 0.9 is kept, which is the evidence for raising or lowering the
threshold. Received invoices carry `expense_type` only.
