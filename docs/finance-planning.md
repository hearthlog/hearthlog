# Finance planning

Finance treats assets as the balances available now and transactions as either future plans or completed history.

## Balance model

- **Available now** is the sum of current assets. Update asset values manually after money moves.
- **Planned** contains active transactions dated today or later. A plan dated today still counts until it is marked done or the day passes.
- **Done** transactions are history: anything marked done, and any plan whose day has passed. Their amounts are excluded from every outlook because current assets already reflect them.
- A plan archives itself when its day passes. Nothing is written: the timeline reads "done" from the date in SQL (`modules/finance/src/data/finance-timeline.ts`), so every device and log agrees without an event. There is no review queue and no navigation badge. A payment that never happened drops out of the outlook without asking, so edit or delete it if it moved.
- The **outlook** covers every plan ahead. Its **lowest ahead** balance is measured at the end of each day from today through the last plan, and **after last plan** is available now plus every plan.
- Balances exist only from today on. Done rows never move a balance, so there is no rebuilt past balance. After the last plan the balance stays constant.

Marking done changes only the transaction status. It never creates or updates an asset event. Today's plans offer **Done** on the row to leave the outlook as soon as assets are updated; any plan can also be marked done early from its menu or the selection bar. Batch status changes share one submission identity so retrying the same action stays idempotent. Mark done offers Undo, which restores the rows to plans. Only a row done ahead of its day can be restored; an earlier day is done by date, and moving it to today or later (in the drawer or with Move) makes it a plan again.

Every balance, running total, grouping, low point, and month total comes from SQLite through `repositories.timeline` (`modules/finance/src/data/finance-timeline.ts`). The page lays rows out and never sums or filters them in JavaScript.

## Endless timeline

Finance is one endless vertical list with no month pages. It opens at Today and scrolls without an end (a hundred years) in the direction its filter runs. It is the shared endless list (`src/lib/components/endless/EndlessList.svelte`, see [adding an endless list](adding-a-page.md#adding-an-endless-list)), virtualized with TanStack Virtual (`@tanstack/svelte-virtual`), one item per month, so only the months on screen are in the page. Each month's rows and totals are read from SQL as it scrolls into view (`modules/finance/src/components/finance/timeline-months.svelte.ts`), and a month that is still loading keeps a placeholder. After a save or a sync, the months on screen re-read and the others load again when they come back.

**Show** has three filters, read from `?show=` and applied in SQL. **All** (the default) lists done history above Today and plans below it, and runs both ways without end. **Planned** (`?show=planned`) starts at today's month and runs on ahead. **Done** (`?show=done`) runs back without end and stops at today's month, or at a later month holding a row marked done early. Old `?view=archive` links open Done. Each filter has its own list, so switching reopens it at the month in view, clamped to the filter's months.

`/finance` opens at Today. `/finance/<year>/<month>` opens at that month's header, or at Today for today's month. The address follows the month in view quietly (`replaceState`), so a reload opens where you were. After opening or a jump, the month you went to counts as the one in view until you scroll by hand or it leaves the screen. Otherwise the month at the top of the list is the one in view.

The month navigator names the month in view. Its arrows (and ← → keys outside the list), the month picker and **Today** scroll the list instead of loading a page, stopping at the filter's first or last month. When Today is off screen, a **Today** button floats at the bottom of the list. The readout's **Lowest ahead** and **After last plan** scroll to their day, switching from Done to Planned first.

Each month has a header that stays pinned while its rows scroll. From today's month on, under All and Planned, the header shows opening → closing (change) of the plans, and its tooltip adds their income and expenses; today's month opens at available now. Earlier months, and every month under Done, show the month's done income, expenses and net instead, with no balances. A month with no rows collapses to a single line.

Today's month holds done rows up to today, dimmed with a check (not under Planned), then the **Today** line with the balance available now, then plans, each with the balance after it, and any rows marked done ahead of their day. Today's plans show **Done** in place of their balance. The row with the lowest balance across every plan ahead is emphasised, and turns amber when it is below the floor.

All and Planned draw the balance river beside the rows, on one fixed scale: available now and every plan's end-of-day balance, plus the floor when it is near them. Horizontal position is the balance in Kč. The river starts at the Today line; done history above it keeps the gutter empty. Each row below Today draws its own piece of the line as a dashed projection, stepping sideways by exactly its amount, so the line runs unbroken through every later month. Each later month's header marks its opening balance, and the lowest balance ahead is marked. Hovering a row shows the balance before and after it. Done draws no river.

## Floor

The readout's **Floor** is a personal warning line, stored per device in local KV (`modules/finance/src/finance/floor.ts`), not as an event. The lowest balance ahead and the river mark where plans go below it.

## Batch selection

Every row has a checkbox. The selection bar offers "Select all" for the transactions of the month in view. The bar aggregates in SQL and shows the count plus income, expenses, and net of the selection. Batch actions are:

- **Move**: reschedule the whole selection to a new date.
- **Mark done** for the selected plans, or **Restore** for rows done ahead of their day. A selection of earlier days offers neither.
- **Move** of an earlier day to today or later also makes it a plan again.
- **Delete**, which asks for confirmation first.

Each batch is one submission identity, so retrying the same action stays idempotent. On mobile the bar becomes a floating card and replaces the Add transaction button while a selection is active. Changing the filter drops the selection.

Budget items on the Budget plans tab use the same selection and totals bar with per-row and per-section checkboxes. Their only batch action is Delete — there is no move for budget items. Switching plans drops that selection.

## Interaction model

The readout replaces separate metric tiles. It shows:

- **Available now**, which opens current assets for editing.
- **Lowest ahead**, across every plan.
- **After last plan**, with the day of the last plan.
- The **Floor**.

On desktop the list scrolls inside its panel. On smaller screens the page scrolls around it, and the list fills the screen with its own month and filter controls on top. Drag the header or those controls to bring the readout back, and scroll the list itself to move through time.

The transaction drawer uses an Expense/Income choice and accepts a positive magnitude. New transactions are added only through this drawer:

- The header's **Add transaction** (on mobile, the floating button) opens it on today in today's month. In another month it opens on the first day in view.
- The title stays **New transaction**. The save button reads **Plan transaction** or **Record transaction** depending on the date.
- Anything dated before today is recorded as done, without changing assets. An entry dated today shows **Already happened**: checked for a done transaction, unchecked for a new entry or a plan, which stays planned for today. A later date is a plan, unless the row was already marked done ahead of its day.
- When a saved entry lands outside the filter or month in view, its confirmation names the day and offers **Show**, which switches to the filter that lists it.
- **Repeat** (new transactions only) is **Once** or **Daily** for 2 to 366 days. Daily adds one ordinary transaction per day with the same name, amount and category, all in one command. A line under it shows the count, total and dates, and the save button names the count. Days before today are done, today follows **Already happened**, and later days stay plans. The confirmation offers **Undo**, which deletes the whole set. Afterwards, change several days at once with the selection bar.

Editing an existing transaction offers Delete in the drawer, which is how rows are removed on mobile; desktop rows also have an actions menu.

All date boundaries use the active workspace clock.
