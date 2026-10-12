# Budget planning

Finance includes a **Budget plans** tab for planning a budget without creating
transactions. Plans are universal: the same scenarios apply to every month, so
switching months never changes them.

Plans contain positive income and expense amounts. Their type is stored
separately, so the interface does not require negative expense values. The
summary shows planned income, planned expenses, and the remaining amount
(`income - expenses`). All plan selection, item filtering, counting, and totals
run in SQLite within the active tenant and log read session.

Creating, renaming, duplicating, and deleting plans uses the normal local event
command and outbox path. Duplicating copies the current plan and all of its
items as one action. Deleting a plan removes its items in the same action, so a
single Undo restores the complete plan. Budget plans remain available offline
and are read-only while viewing history, like other Finance data.

Planned items are listed in the shared data table with a selection checkbox and
Name, Category, Amount, and Actions columns. Every row keeps an explicit edit
action that reopens the item drawer with its values, and amounts always show two
decimals in a right-aligned, tabular column. Income and expenses each sort
independently by name or amount: the column headers cycle ascending, descending,
then back to the creation-order default, and the choice lives in the URL
(`incomeSort` / `expenseSort` as `name-asc`, `name-desc`, `amount-asc`, or
`amount-desc`) so reloading or sharing a link keeps the order.

Each item row has a selection checkbox and each section header selects its whole
section; the selection bar offers "Select all" across the plan and aggregates
income, expenses, and net in SQL. The only batch action is Delete: it asks for
confirmation first and runs as one submission, so a single Undo restores the
items. There is no move action for budget items, and switching plans drops the
selection.
