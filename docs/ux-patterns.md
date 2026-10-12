# Page UX patterns

These patterns keep the app visually consistent while each feature owns its
content and workflow. The active tenant's `--stor-*` tokens remain the source
of colors and elevation in light and dark mode.

## Page anatomy

1. Use `PageHeader` for the page's single `h1` and the page's desktop action.
   Section pages leave `showTitle` off: the title is read by
   assistive tech and shown as a compact label on mobile only, because the
   navigation already names the place. Detail pages that name their subject
   (an invoice, a book, a snapshot) pass `showTitle`. The `tabs` and `context`
   snippets share one row with the action. There is no page description or
   subtitle — state belongs in panels, guidance belongs in the empty state or
   a tooltip.
2. Use `RouteTabs` for links to sibling routes or URL states. Pass contextual
   URLs and mark the current link through its `active` property. Use the
   `section` variant for a collection's status routes; it supports an icon
   and count while retaining link semantics. In-page
   panels still use Bits UI tabs; small local view options remain segmented
   buttons. These controls share visual rules but keep their own semantics:
   one capsule track (`--stor-surface-muted`, hairline ring, radius-full)
   whose selected pill is raised on `--stor-surface-raised` with accent text,
   never a bare color change or a floating underline. The pill is measured by
   `tabIndicator` (`components/ui/tab-indicator.ts`), attached to every tab
   row, and slides between triggers with `--stor-tab-motion`; reduced motion
   removes the slide. Page-level links use
   the larger `stor-primary-tabs` sizing, compact in-panel rows the smaller
   `stor-section-tabs` sizing; both hug their content on desktop and scroll
   inside the track on narrow screens.
3. Use `MonthNavigator` for month-based pages and `HealthDaysShell` for daily
   diaries: a Monday-to-Sunday strip over days you swipe between, each with
   its own serif date. Pass the contextual current date, not the wall clock, in
   history mode. Both keep navigation and the return-to-Today action in one
   place.
4. Use `Panel` for ordinary content surfaces and `Metric` for compact
   label/value/supporting-text summaries. A panel can own its header, body,
   and action; feature content stays inside it. Prefer whitespace and the
   shared shadow over additional nested cards.
5. Put one frequent primary action in the page header on desktop. Use
   `MobilePageAction` when that action should stay reachable while scrolling: it
   is a pill sized by its label at the bottom right, above the bottom navigation
   on phones and at the bottom edge on tablets; a second action is an icon
   beside it. Wrap mutation controls in `CommandOnly`, and
   hide the mobile action while its drawer is open.
6. On a phone, one surface scrolls per screen: a page whose list scrolls itself
   fits the screen, and an endless list never sits inside a scrolling page.
   The page's main content starts on the first screen
   (`docs/design-concepts/mobile-2026-10-04`).

## Phones

Below 768 px, where the dock is, each page does one job
(`docs/design-concepts/phone-focus-2026-10-04`). Everything here is scoped to
that width; from 768 px pages render as on tablets and desktops.

- **One top bar** (`NavBar`, 52 px): the section in small type over the
  sub-page in the serif, a menu of sub-pages when the section has them (the
  same registry entries the sidebar lists), the page's one figure, and a round
  log button. In a copied log the log keeps its name in the bar. The page
  label and the sub-page tab row step aside (`PageHeader` stays for its `h1`).
- **One figure in sight.** A page adds `PhoneGlance` with the figure that
  decides the next step (Finance: Available now, or the low point once it
  drops under the floor; Invoices: Overdue, else Outstanding; Health: the
  day's figures via `HealthGlance`; Budget: Remaining; Body: weight;
  Calendar: the next pinned event). Tapping it opens a sheet that renders the
  page's desktop figure components, so phone and desktop never disagree. The
  same figures on the page itself hide below 768 px.
- **Controls behind one button.** Filters, view switches, sorting and Select
  sit behind a slider icon at the head of the list, with a dot when anything
  differs from the default. Attention (uncategorized, overdue) is a small
  chip there, never a banner.
- **Rows at rest have no controls.** No checkboxes until press and hold
  (`longPress` in `src/lib/utils/long-press.ts`) or Select starts selecting;
  while selecting, a tap ticks the row and the top bar reads "N selected ·
  Select all · Cancel" (`phoneHeader.selection`) over a slim action bar.
  Today's plans keep their Done.
- **Forms are sheets.** Every `Drawer` is a sheet from the bottom sized to its
  content, with the page dimmed above it and lifted by the on-screen keyboard
  (`--stor-keyboard`). It closes by its × or the dimmed page, so footer Cancel
  buttons and drawer descriptions step aside.
- **Required first.** Forms put what must be filled first and fold optional
  fields under one line that opens on an error. Adding a transaction asks for
  the amount first and offers Today, Tomorrow and the most used categories
  (counted in SQL) as chips, a Pick date chip and All categories, and an
  Already happened switch (`ui/Switch.svelte`); the save button names the
  result. Health logs in place: Log opens `QuickFoodLog` (search and recent
  foods fill the form, name and kcal on one row, the time in the header),
  `QuickActivityLog` (Steps · Workout, the number with the keypad) or
  `QuickWeighIn` (one number; height from the last weigh-in) over the page,
  and the Nutrition, Activity and Body pills open the same forms. The full
  forms (catalog, barcode, custom activities) stay a link away; `QuickFoodLog`
  has Recent · Library · Online tabs (Online searches the external catalog and imports the food into the library when the entry is saved), and a library food takes its portion on a stepper.
- **Sheets replace, never stack** (`docs/design-concepts/phone-forms-2026-10-05`).
  A sheet opened from a sheet takes its place (`sheetStack` in
  `src/lib/runtime/sheet-stack.svelte.ts`, used by `Drawer` and `Modal`): the
  one below hides, the top one has a back arrow, its × closes all of them.
- **Choose before typing.** Values a person picks from a few are
  `ui/ChoiceChips.svelte` (recent customers, VAT, expense types, targets,
  suggested categories) with an All or Other chip for the rest; dates are
  named ranges (Overdue, This quarter) with Pick.
- **Defaults as one line.** What a form fills in itself (the next invoice
  number, today, the customer's last term, the last supplier) reads as one
  line (`ui/FoldLine.svelte`) that opens the fields, and opens on an error.
- **The button names the result**: "Create invoice · 12 100 Kč", "Apply 4
  categories", "Set 2 000 kcal", "Save 3 changes". Meal parts of day save per
  change with Undo; asset balances save in one sheet as one command.
- The page action (`MobilePageAction`) shrinks to its icon while its page
  moves when its label sits in `.stor-action-label`.

## Forms at every width

The phone form rules apply to desktop and tablet too
(`docs/design-concepts/desktop-backport-2026-10-05`); only the geometry differs.

- A drawer opened from a drawer replaces it, with a back arrow (`sheetStack`).
- Choices are `ChoiceChips` (arrow keys move between chips) before a Select;
  optional fields and defaults sit behind one `FoldLine`; the button names the
  result. Drawer descriptions and "Optional"/"0 = unset" hints are not used.
- Log food is `QuickFoodLog` everywhere: Recent · Library · Catalog over one
  search, a portion stepper for a chosen food. Barcode scanning is a link to the
  full form on Nutrition.
- Attention is a chip in the toolbar (Invoices: "2 overdue"), never a banner.
- Native `<select>` is not used; use `ui/Select`. Asset balances update in one
  sheet from the assets panel ("Update balances").

## Titles

Page labels, detail-page titles, the month title, and drawer, modal, and
confirmation titles use the system serif (`--stor-font-serif`: New York on
Apple devices, then Iowan Old Style, Charter, or Georgia) through
`.stor-serif-title`. Navigation, tabs, controls, data, and body copy stay in
Inter. No web font is loaded for the serif, so first paint is unchanged.

## Copy budget

Visible text has three tiers: the page `h1`, a panel title, and a
label/value pair. One support line per panel is enough; definitions and
formulas belong in a `Tooltip`, and explanations belong in the empty state or
a conditional hint.

Keep a sentence only when it changes a decision (a warning, a deadline, a
constraint), disambiguates a number with a non-obvious baseline, or carries a
unit or comparison. Do not restate the label in a subtitle, repeat a period
or count in a page description, or explain a number that reads by itself
(`Available now` does not need `current assets`). Empty states are a short
title, one line, and one action.

## Collections and states

`CollectionToolbar` aligns search, filters, result count, and Clear filters.
Its controls wrap within the panel at narrow widths, and the count and Clear
filters remain together without an extra divider.
Search and filter values that define the visible collection belong in URL
params so reload and Back/Forward restore them. Repositories perform the
filtering and ordering in SQLite through `queryDatabase`; the toolbar owns
presentation, not data processing. Tables and feature-specific rows keep
their own markup.

For a long set of quick status filters, keep one horizontal row from tablet
up. On phones the row steps aside: Status chips and Sort by (field and
direction) sit in the list's Filters and sort sheet. Reveal the selected option when restoring a filter from the URL, and keep the
full filter drawer available for less frequent criteria.

Use `PageDataStatus` for page errors and refresh state, `DataPlaceholder` for
loading content, and `EmptyState` for a whole empty region. Pass
`surface={false}` to `EmptyState` when a parent panel already owns the
surface. Keep errors actionable and preserve the user's draft after a failed
save.

## Color, controls, and density

Keep page titles and section headings in `--stor-ink`; use the tenant accent
for active navigation and primary actions. Amounts use `formatMoney` /
`formatAmount` from `#lib/utils/number-format.js` (Czech grouping, a true minus,
decimals only for fractional amounts) and `Amount` for large figures, whose unit
is smaller and muted. Negative amounts stay in ink; only income is coloured,
and red is reserved for overdue work and errors. A zero with nothing behind it
is muted text such as "None planned", never a coloured value. A filled action pairs
`--stor-action` with `--stor-action-text`. A filled destructive action pairs
`--stor-negative` with `--stor-negative-text`, so its label remains legible in
both appearances. Use `Badge` and the semantic positive, negative, warning,
and info tokens for status. Do not use an accent color to imply a status.

Surfaces use four radii: 8px small tiles, 12px controls and inner blocks, 20px
panels, and full pills. Panel padding is at least the panel radius (20px, 24px
from `lg`). `--stor-surface-muted` and `--stor-surface-hover` are neutral; the
accent tint (`--stor-selected`, `--stor-accent-soft`) means selection. Panel
shadows are a hairline ring, a contact shadow, and a soft ambient shadow; dark
panels use a faint rim and top highlight instead. Uppercase labels are only
for group headings (10.5px, 0.1em tracking); metric and field labels use
sentence case. List rows use inset dividers (`stor-inset-rows`) that start at
the row text.

Use the shared `Button`, `Input`, `Select`, `Textarea`, and `Field` controls in
new forms. Where a native select or input is required, `stor-native-field`
matches their height, radius, focus treatment, and theme colors. Ordinary
rows sit on the panel surface with a quiet divider; use a tinted inset only
for selection, status, or a distinct task. Controls remain at least 44px tall
on mobile and become compact from `sm` upward.

Drawers enter with one short panel slide and a light overlay fade. Keep their
contents stationary during that motion so fields are readable and ready to use
immediately; reduced-motion settings remove the transition. The footer has a
quiet divider, and on mobile its primary final action grows into the remaining
width. Confirmation dialogs and modals use the same tenant-aware surfaces and
unblurred overlay; a confirmation opened from a menu must appear above that
menu. Keep Cancel as the initial focus in destructive confirmations.

The sidebar marks the active destination with the same raised pill as tabs, and
the pill glides between rows (`navIndicator`, the vertical sibling of
`tabIndicator`; reduced motion snaps). Selection is ink, for the icon, the
sub-page label and its bar, so red keeps meaning late work. Sections with
several views (Finance, Invoices, Health) list their sub-pages under the active
item, which open in place; while the sidebar is expanded, `PageHeader` hides the
matching tab row (`sidebarTabs`) and the section label, because the sidebar
names the place. The top of the sidebar is the brand and the collapse toggle.
The foot holds the log, its version, and its sync state (`LogStatusChip`)
above a one-line account row, and the phone top bar carries it as a round
button (with the log's name while in a copied log).
The version pill (`v42`) counts the accepted head plus local saves that have no
version yet, so a save moves it before sync catches up; an empty log shows
none. Sync that is fine stays silent: the text says Synced and there is no
dot. A dot marks saving, offline or needing review, and the control turns
negative when sync needs attention.

The sidebar has two forms. Expanded (224px by default) is available from 1024px and
opens by default from 1280px; below 1280px it opens as a rail (80px), and a choice
made with the toggle (stored in `stor:sidebar-collapsed`) always wins. From 1024px
the sidebar's edge (`SidebarResizer`, a focusable `separator`) drags the width
between 192px and 336px, snapping to 224px within 8px; dragging narrower than
136px folds it to the rail, and dragging the rail wider opens it. The width is a
device preference in `stor:sidebar-width` and drives `--stor-sidebar-width`, which
the aside, the root padding and the boot shell all read. Double-click resets,
arrow keys resize by 16px, Enter folds or opens. Size rules live in
`sidebar-size.ts`. From 768px to
1023px the rail is the only form and replaces the phone header and dock, so the
mobile chrome heights (`--stor-mobile-header-height`,
`--stor-mobile-nav-height`) fall to zero there and pages and fixed bars that size
themselves from them follow. In the rail a section without pages names itself in
a `Tooltip`, and a section with pages opens a flyout (`NavFlyout`) beside the
rail, on a real mouse's hover or on keyboard focus; a tap simply navigates. The
page then keeps its tab row and shows its section label, as on phones. The boot
shell in `src/app.template.html` applies the same rule so first paint does not
jump.

Account, appearance, and maintenance pages (Entities, Developer) live in the
account menu on desktop and tablets and in More on phones. Navigation badges
count only late work (overdue invoices) from SQL counts that modules
contribute (`attention` in the manifest; Invoices: `modules/invoices/src/attention.ts`). The count sits on the sub-page that holds the work
(Issued) while its section is open and on the section itself while it is closed;
in the rail it is a dot, with the number in the tooltip or flyout. Each page
repeats the signal as one banner with a single action. Finance has no badge:
past plans archive themselves. Health
opens on **Day** (`/health`) whenever at least two Health features are
enabled; with one, it opens that feature's page. Eat, Move, and Body each own
one colour of the tenant's chart palette (`--stor-health-eat`, `-move`,
`-body`, applied with `.stor-tone-*` so tints follow the surface in light and
dark), and a domain wears it on every Health page. The day-based pages (Day,
Nutrition, Activity) show one day at a time (`HealthDaysShell`,
`HealthDaysList` on `DayPager`, see [adding an endless list](adding-a-page.md#adding-an-endless-list)):
they open on today unless the address specifies a day with `?date=`, and keep
that day in view when the window or scrolling layout changes.
Swiping across changes the day and scrolling down reads it, since every day
scrolls on its own. A Monday-to-Sunday strip with a pip per domain, week
arrows, and the page's one primary action sits above the days, and its pill
slides along while the days move. At every size each swipe ends on a day, and
the days either side peek in by 12 px. Each day opens with its own serif date (`HealthDayTitle`, which stays
at the top while its day scrolls), so switching days never reloads the page and
nothing flashes, and a day you leave starts at its top when you come back. The
week panels for the day in view sit beside the list from `lg`; tablets open
them from a **Week** button in the date row, and phones from the sheet behind
the top bar's figures, where the day's readout and charts also live (the date
row steps aside there and the top bar names the day). The address follows the day in view (`?date=`) once the days
come to rest, the arrow keys step a day, and **Today** floats over the days
when today is off screen. Day reads as a slim readout of the three numbers
over one timeline of meals and movement ordered in SQL
(`modules/health/src/data/health-day.ts`). A day at least 32rem wide flanks the timeline
with two gutters that draw the running calories and steps, stepping sideways
at every entry with a dotted line at the target, amber past a calorie budget;
a narrower day (a phone) gets the same as two step charts above the list. The usual pace (the mean of the last 14 tracked
days at that time, calories only) is off by default and remembered on the
device. Nutrition cuts the day's calories into its meals on a budget bar,
Activity shows steps as a ring per day and the week's workouts as a ladder in
the week panel, Body is a weight chart (seven-day mean, hollow weigh-ins, a
soft reference range) over a sortable, paged table of weigh-ins with their
change, and the Food library is a sortable, paged table that shows where each
food's energy comes from. Both tables are the shared `DataTable` in its `quiet`
variant: SQLite sorts, filters and pages them, the sort, page and size live in
the address, and the rows on screen stay until the next page arrives. The charts share one language: tinted tracks, a dotted
target, a check when a minimum is reached, hatched amber past a budget.
Everything that was logged is a `HealthRow`: time, a tile in the domain
colour, a name with at most one support line, one amount. On phones a row
keeps one actions menu instead of an icon row, so names stay readable. The mobile
dock holds Finance, Invoices, Calendar, Health, and More; its active item uses
a tinted pill, and while the More sheet is open it owns the selection. The sheet
keeps the log and sync as one row and shows sync details only when sync needs
attention. Record sync badges report an individual record's state. Shared buttons use the same
focus treatment and restrained hover/press states in every tenant theme.

Calendar's first job is working time. Its grid is one endless run of weeks
(see [month navigation](month-navigation.md)); days outside the month in view
step back, a stepped line runs between months, and each month's first day
carries the month's name. The month title
carries the working-day count of the month in view, weekday holidays are named
in the grid, and the selected
day says whether it is a working day (and which one), a weekend, or a named
holiday. A Month summary panel (first in the side column on desktop; on phones in
the sheet behind the next pinned event in the top bar) shows working days and hours against the previous
month, progress through the current month, weekends and holidays, quarter and
year totals, the month's holidays, and scheduled items per visible source.
On phones the grid is the page and its only scroller: weeks are 104 px, so a
whole month is on screen with each day naming its events, and a tapped day
opens its agenda in a card above the dock while the grid stays live.
Working days follow the weekend and Czech public-holiday rules in
`src/lib/calendar/logic.ts` (8 hours a day); scheduled counts are one SQL
aggregate (`getCalendarSourceCounts`) under the same source filter as the grid.

## Responsive and history checks

Check at 1440px, 1100px (rail), 820px (tablet), 390px, and 320px in each appearance. Tabs must stay
scrollable, the primary action must clear the bottom navigation, and drawers
must keep their footer action visible. Verify keyboard focus, URL restoration,
offline reads, tenant feature gating, and history links with
`contextualHref`. History mode removes mutation actions through `CommandOnly`.
Month picker triggers and the return-to-Today control retain 44px touch targets;
the reserved Today slot keeps month arrows in place when its visibility changes.
