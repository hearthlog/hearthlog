# Time Travel UX Design

> Status: historical design study. App-wide time travel, restore, and event
> removal controls were retired in favor of [Log history and forking](history-and-restore.md).

## Purpose

This document turns the read-only time travel feasibility study into a full app design. The goal is to make historical viewing feel deliberate, understandable, and safe across the whole app.

The design principle is simple: history is a frozen inspection mode. The user can move around the app and inspect state at a selected point, but cannot change data until they return to Now.

## Design goals

- Make it impossible to miss that the app is in history mode.
- Keep the selected historical point pinned while the user navigates.
- Preserve normal page structure so historical data is easy to compare mentally with the live app.
- Disable write paths consistently without making screens feel broken.
- Let the user return to Now from any screen.
- Use durable log order for history while allowing date and event-based selection.

## Non-goals

- Editing historical data.
- Restoring a past snapshot.
- Branching from the past.
- Comparing two historical points side by side.
- Showing pending local events in historical snapshots.

## Mental model

The app has two global data modes.

| Mode | Meaning | Writes | Sync display | Data source |
| --- | --- | --- | --- | --- |
| Now | Current live state, including local pending events | Enabled | Normal | Live read model |
| History | Frozen state at a selected synced log version | Disabled | Background only | Snapshot read model |

The user should understand that history mode is not "the app went back in time". It is "the app is showing a read-only snapshot from the selected log".

## Core UX contract

1. Entering history creates a pinned snapshot.
2. Navigation does not change the snapshot.
3. Background sync does not move the snapshot.
4. Write actions are removed or disabled.
5. Log switching exits history unless the user explicitly chooses a point in the new log.
6. "Return to Now" is always visible.

## Information architecture

History mode is global shell state, not page state.

```text
App shell
  Sidebar / mobile header
  Global history mode bar
  Page content
  Mobile bottom navigation

History tools
  Entry button
  Picker drawer
  Active mode bar
  Event stepper
  Read-only guard
```

The first release should expose history from the developer page and global shell. Developer users can validate correctness before history is promoted as a primary user feature.

## App states

### 1. Now

Default state. The app looks as it does today, with one small entry point for history.

Desktop placement:

- Add a "History" icon button under the log switcher or near the sync card in the sidebar.
- In expanded sidebar, show icon plus "History".
- In collapsed sidebar, show icon only with tooltip.

Mobile placement:

- Add "History" in the More sheet.
- Do not add a sixth item to the bottom nav.

Primary copy:

- Button label: `History`
- Tooltip: `View a past snapshot`

### 2. Picking A Snapshot

Opening History shows a drawer/sheet with three ways to select a point.

Desktop:

- Right-side drawer, width around 420 px.
- The rest of the app remains visible.

Mobile:

- Bottom sheet with max height around 85dvh.
- Keep the mobile header visible above the sheet when possible.

Picker structure:

```text
History
View this log at a previous synced point.

[ Date and time ] [ Event ] [ Version ]

Date and time
[ Jun 14, 2026 ] [ 10:42 ]
Resolved point: version 128, after TRANSACTION_UPDATED

Recent events
[ v132  Invoice updated       10:56 ]
[ v131  Asset updated         10:51 ]
[ v130  Transaction removed   10:49 ]
[ v129  Transaction added     10:44 ]
[ v128  Transaction updated   10:42 ]

[Cancel]                         [View History]
```

Tabs:

- Date and time: fastest for normal use.
- Event: best for stepping through changes and debugging.
- Version: precise technical fallback.

The primary button is disabled until a resolved synced log version exists.

### 3. Loading Snapshot

After selection, show a short loading state in the drawer and then close it when the snapshot is ready.

Copy:

- `Building snapshot...`
- `Preparing version 128`

Do not replace page content with a full-screen loader unless projection takes longer than 500 ms. If it takes longer, show a non-blocking bar under the nav:

```text
Building history snapshot for version 128...
```

### 4. Active History

When active, a persistent global bar appears above page content.

Desktop wireframe:

```text
+---------------- sidebar ----------------+-----------------------------------+
| stor                                     | History: Jun 14, 2026 10:42       |
| [Current log]                            | v128  Transaction updated          |
|                                          | [Prev] [Next]      [Return to Now] |
| Workspace                                +-----------------------------------+
| Finance                                  |                                   |
| Calculator                               | Page content rendered from         |
| Calendar                                 | pinned snapshot                    |
| Invoices                                 |                                   |
| Entities                                 |                                   |
| Developer                                |                                   |
|                                          |                                   |
| [Synced]                                 |                                   |
| [Undo disabled in history]               |                                   |
+------------------------------------------+-----------------------------------+
```

Mobile wireframe:

```text
+------------------------------------------------+
| s                       Finance          More   |
+------------------------------------------------+
| History: Jun 14, 10:42                         |
| v128 Transaction updated      [Now]             |
| [Prev]                              [Next]      |
+------------------------------------------------+
|                                                |
| Page content from snapshot                     |
|                                                |
+------------------------------------------------+
| Finance   Calc   Calendar   Invoices   More    |
+------------------------------------------------+
```

The active bar should be compact but unmistakable.

Recommended contents:

- History icon.
- Human-readable timestamp.
- Log version.
- Event summary for the selected boundary.
- Previous event button.
- Next event button.
- Return to Now button.

Desktop layout:

- Single horizontal row when width allows.
- Wrap event summary under timestamp on narrower desktop widths.

Mobile layout:

- Two rows.
- First row: timestamp, version, Now button.
- Second row: previous and next controls.

### 5. Empty Historical State

If a page has no data at the selected point, use the page's normal empty state, plus the global history bar. Avoid special copy that implies data loss.

Optional local helper text:

- `No records existed at this point.`

### 6. Snapshot Error

If a selected point cannot be projected, keep the app in Now and show a notification plus inline picker error.

Copy:

- Notification: `Could not build that history snapshot`
- Drawer detail: `Try a different event or return to the current view.`

Do not leave the app half-entered into history mode.

## Components

### HistoryEntryButton

Purpose: Opens the picker.

Desktop expanded:

```text
[history icon] History
```

Desktop collapsed:

```text
[history icon]
```

Mobile:

Appears in the More sheet as a row action.

States:

- Default.
- Disabled when no log is selected.
- Disabled while a snapshot is building.

### HistoryPickerDrawer

Purpose: Choose the snapshot boundary.

Layout:

- Header with title and close button.
- Short explanation.
- Segmented control for Date and time, Event, Version.
- Resolver preview.
- Primary action footer.

Controls:

- Date input.
- Time input.
- Event search field.
- Event list.
- Version number input.

Event list row:

```text
v128  Transaction updated
Jun 14, 2026 10:42      transaction:8f2a...
```

Event row details:

- Version.
- Human event label.
- Timestamp.
- Entity hint when available.

### HistoryModeBar

Purpose: Persistent global indicator and navigation control while in history.

Desktop content:

```text
[history icon] Viewing history
Jun 14, 2026 10:42
v128
Transaction updated
[Previous event] [Next event] [Return to Now]
```

Mobile content:

```text
History: Jun 14, 10:42   v128   [Now]
[Previous event]                 [Next event]
```

Behavior:

- Sticky within the app shell.
- Does not cover page content.
- Remains visible across route changes.
- Shows loading overlay only inside the bar when stepping to another point.

### HistoryEventStepper

Purpose: Move one event backward or forward.

Rules:

- Previous moves to the prior synced log version.
- Next moves to the next synced log version.
- Next is disabled at the latest synced version unless the user is not in Now; in that case the final next step can remain a normal step, while Return to Now exits fully.
- Buttons use chevron icons and tooltips.

Labels:

- `Previous event`
- `Next event`

### ReadOnlyGuard

Purpose: Central behavior pattern for write controls.

Rules:

- Primary create buttons are hidden when their absence does not confuse layout.
- Existing-item edit/delete actions are disabled when the user needs to understand why they cannot act.
- Forms already open before entering history close or switch to read-only summary.
- Confirmation dialogs for destructive actions cannot open in history mode.
- Keyboard shortcuts that write are ignored and show a notification.

Notification copy:

- `Return to Now to make changes.`

### SnapshotMeta

Purpose: Small metadata block used in developer views and event drawers.

Fields:

- Log name.
- Log version.
- Boundary event ID.
- Snapshot built at.
- Event timestamp.
- Included event count.

This is mostly for debugging and support.

## Visual design

The app currently uses a neutral stone shell with status colors for sync. History should introduce a distinct but restrained accent, not a warning color.

Recommended token direction:

| Use | Tailwind direction |
| --- | --- |
| History bar background | `bg-sky-50` |
| History bar border | `border-sky-200` |
| History title text | `text-sky-950` |
| History secondary text | `text-sky-700` |
| History icon surface | `bg-sky-100 text-sky-800` |
| Read-only disabled controls | `bg-stone-100 text-stone-400 border-stone-200` |
| Return to Now button | `bg-stone-950 text-white` |

Do not recolor the entire app. Only the global history bar, the entry button active state, and selected picker rows should use the history accent.

Icon set:

- History entry: `mdi/history`
- Read-only indicator: `mdi/lock-outline`
- Previous: `mdi/chevron-left`
- Next: `mdi/chevron-right`
- Return to Now: `mdi/restore` or `mdi/clock-check-outline`
- Event list: `mdi/timeline-clock-outline`

Shape and density:

- Match current `rounded-xl` controls in the app shell.
- Use `rounded-lg` or `rounded-xl`; avoid larger pill-heavy treatment except for compact status chips.
- Keep the bar dense: it is state chrome, not a marketing banner.

## Copy guidelines

Use "History" for the mode name and "Now" for live state.

Preferred copy:

- `Viewing history`
- `Return to Now`
- `View History`
- `Previous event`
- `Next event`
- `No synced events before this time`
- `Return to Now to make changes.`
- `Snapshot pinned at version 128`

Avoid:

- `Time travel activated`
- `Go back to the future`
- `Restore`
- `Rollback`
- `Revert`

Those terms imply mutation or playfulness that does not match the feature.

## Interaction details

### Entering history

1. User opens History.
2. User selects a date/time, event, or version.
3. App resolves the selection to a synced `log_version`.
4. User chooses View History.
5. App builds the snapshot.
6. The drawer closes and the history bar appears.

If the current route is unsupported in phase 1, keep the route but show an unsupported state inside page content:

```text
This page is not available in history yet.
[Return to Now]
```

### Leaving history

The user can leave through:

- Return to Now button.
- Log switch.
- Browser URL with no history params.

Leaving history:

- Clears snapshot state.
- Drops or ignores temporary snapshot tables.
- Invalidates live route data.
- Restores write controls.

### Stepping through events

Previous and Next should feel instant for small logs. If projection takes noticeable time:

- Keep current snapshot visible.
- Show loading state inside the bar.
- Disable stepper buttons until the next snapshot is ready.

Never blank the page during stepping.

### Route navigation

History mode persists across route navigation:

- Finance -> Invoices keeps the same snapshot.
- Invoices -> Entities keeps the same snapshot.
- Developer -> Finance keeps the same snapshot.

The URL should carry the selected version:

```text
/finance/2026/6?asOfVersion=128
/invoices?asOfVersion=128
/entities?asOfVersion=128
```

If the user navigates to a route without the param while history state is active, prefer keeping app state active and updating the URL. This avoids accidental exit from copied internal links. A later implementation can make this stricter if deep links become more important.

### Browser back and forward

Back should restore previous history selections when possible.

Expected behavior:

- Now -> select v128 -> select v121 -> Back returns to v128.
- Back again returns to Now.
- Forward re-enters v128, then v121.

This requires snapshot state to follow URL state.

### Log switching

Switching logs while in history should show a confirmation only if there is an active snapshot.

Copy:

```text
Switch log?
History is pinned to the current log. Switching logs will return to Now.

[Cancel] [Switch and Return to Now]
```

If this creates too much friction, skip confirmation and exit history automatically, but always show a notification:

```text
Returned to Now after switching logs.
```

### Background sync

Sync can continue in the background, but the history snapshot remains pinned.

History bar can show a subtle secondary message when new current data arrives:

```text
Current view updated in the background.
```

Do not automatically advance the selected historical version.

### Unsynced local changes

If pending local changes exist when entering history, show a note in the picker:

```text
Pending local changes appear only in Now. History uses synced log versions.
```

This prevents confusion when live data differs from the latest historical snapshot.

## Route-specific design

### Finance

Finance is the highest-value history route.

Requirements:

- Assets summary reads from snapshot source.
- Transactions list reads from snapshot source.
- Daily balance calculation uses snapshot assets and transactions.
- Forecast uses snapshot assets and transactions or is hidden until snapshot-aware.
- Add transaction is hidden.
- Transaction edit/delete actions are disabled.
- Asset edit/delete actions are disabled.

Page-local label:

```text
Balances shown as of version 128.
```

Only show this if it fits naturally near summary metrics; the global bar remains the main indicator.

### Invoices

Requirements:

- Invoice list reads from snapshot source.
- Invoice parties read from snapshot source.
- Create invoice is hidden.
- Edit/delete/status actions are disabled.
- Export or print can remain enabled if it does not write.

If exporting a historical invoice is allowed, the output should include a small generated-from-history note in metadata or filename:

```text
invoice-2026-001-as-of-v128.pdf
```

### Entities

Requirements:

- Entity type list reads from the historical schema when dynamic entity support exists.
- Static entity types can be shown immediately.
- Dynamic entity types hidden before their definition event.
- Create/update/remove entity actions are disabled.

Phase 1 fallback:

```text
Dynamic entity history is not available yet.
```

### BMI

The BMI page mixes local device state and event-sourced weight logs.

Requirements:

- Weight history reads from snapshot source.
- Log weight and remove entry are disabled.
- The live height setting is not historical unless derived from weight log events.
- Calculator controls should be visually separated as current-device inputs or hidden in history mode.

Recommended phase 1 behavior:

- Show historical weight history and latest historical log.
- Disable the calculator input section.
- Add a small label: `Calculator inputs are current-device settings.`

### Calendar

The calendar currently may not be fully event-sourced. If it does not read projected historical data, treat it as unsupported in phase 1.

Fallback:

```text
Calendar history is not available yet.
```

### Calculator

The calculator is not historical application state. It can remain usable in history mode if it does not write domain events.

Recommended behavior:

- Keep calculator usable.
- Keep global history bar visible.
- Do not add page-local history copy.

### Developer

Developer is the best first home for validation tools.

Add:

- History picker.
- Event list action: `View app at this event`.
- Snapshot metadata panel.
- Projection diagnostics.

Disable:

- Reset DB.
- Clear outbox.
- Drain outbox.
- Delete current log.

These actions are too destructive to expose while the user is mentally in the past.

## Accessibility

- The history bar should be announced when entering history using a polite live region.
- The Return to Now button must be keyboard reachable before page content.
- Drawer focus should trap while open and return to the History button when closed.
- Disabled write buttons need either hidden text, tooltip, or adjacent explanation.
- Do not rely on blue color alone. Use history icon and `Viewing history` text.
- Stepper buttons need clear `aria-label` values.
- Snapshot loading should use `aria-busy` on the history bar or drawer.

Suggested announcements:

- Enter: `Viewing history at version 128. Editing is disabled.`
- Exit: `Returned to Now. Editing is enabled.`
- Step: `Viewing history at version 127.`

## URL and state design

Recommended URL params:

| Param | Meaning |
| --- | --- |
| `asOfVersion` | Synced log version to view |
| `historyPicker` | Optional flag to open picker from URL |

Examples:

```text
/finance/2026/6?asOfVersion=128
/developer?asOfVersion=128&historyPicker=1
```

State store shape:

```ts
type TimeTravelState =
  | { mode: 'now' }
  | {
      mode: 'history';
      logId: string;
      version: number;
      eventId: string | null;
      eventType: string | null;
      eventTimestamp: number | null;
      snapshotId: string;
      status: 'building' | 'ready' | 'error';
      errorMessage: string | null;
    };
```

The store should be derived from URL plus active log. If URL and active log disagree, return to Now.

## Detailed UI behavior matrix

| Surface | Now | History |
| --- | --- | --- |
| Sidebar History button | Opens picker | Opens picker at current version |
| Sidebar Undo | Enabled | Disabled with tooltip |
| Log switcher | Enabled | Exits history or confirms |
| Sync card | Normal | Normal, with snapshot pinned |
| Add buttons | Enabled | Hidden |
| Edit/delete buttons | Enabled | Disabled |
| Export buttons | Enabled | Enabled if read-only |
| Developer destructive tools | Enabled | Disabled |
| Calculator | Enabled | Enabled if no domain writes |
| Browser refresh | Keeps route | Rebuilds snapshot from URL |
| Background sync | Updates live model | Updates live model only |

## Content examples

History bar, desktop:

```text
Viewing history
Jun 14, 2026 10:42
v128 - Transaction updated
Previous event
Next event
Return to Now
```

History picker empty state:

```text
No synced events before this time.
Choose a later time or return to Now.
```

Disabled action tooltip:

```text
Return to Now to make changes.
```

Snapshot build error:

```text
Could not build this snapshot.
Try another event or return to Now.
```

Unsupported route:

```text
This page is not available in history yet.
```

## Implementation sequence

### Milestone 1: Shell and developer-only history

- Add time travel store.
- Add HistoryEntryButton in sidebar and mobile More sheet.
- Add HistoryPickerDrawer in developer-safe form.
- Add HistoryModeBar.
- Wire URL state.
- Use fake/static snapshot metadata if projection is not ready.

Outcome: The app can visibly enter and exit history mode without changing data.

### Milestone 2: Finance historical read path

- Snapshot assets and transactions.
- Make finance layout/page snapshot-aware.
- Disable finance write actions.
- Add Playwright tests for finance history mode.

Outcome: The most important page works end to end.

### Milestone 3: Invoices, entities, BMI

- Add snapshot-aware read helpers.
- Add route support and read-only guards.
- Add unsupported fallbacks for dynamic entity gaps.

Outcome: Core app pages are safe in history mode.

### Milestone 4: Event stepping and polish

- Add previous/next event stepping.
- Add event search in picker.
- Add loading and error handling.
- Add accessibility announcements.

Outcome: History mode is pleasant enough for daily use.

### Milestone 5: Dynamic entities

- Replay dynamic entity definitions to selected boundary.
- Generate dynamic snapshot tables.
- Support historical dynamic entity pages.

Outcome: Time travel covers the full event-sourced model.

## Acceptance criteria

- User can enter history from the global shell.
- User sees a persistent history bar on every supported route.
- User can return to Now from every route.
- The selected historical version survives route navigation and refresh.
- Write actions cannot execute while history is active.
- Finance renders different data for two different historical versions when events differ.
- Background sync does not alter the active snapshot.
- Log switching cannot leave the app in a stale history state.
- Screen reader users receive enter, exit, and step announcements.

## Open decisions

- Whether the first public entry point should live only in Developer or also in the main sidebar.
- Whether log switching should confirm or silently return to Now.
- Whether timestamp selection should show nearest event before the time or exact event only.
- Whether historical exports are allowed for invoices.
- Whether calculator remains interactive in history mode or is fully read-only for consistency.

## Recommended first version

Ship the following first:

- Sidebar/mobile More entry point.
- Right drawer/bottom sheet picker.
- Date/time selection plus recent event list.
- Persistent history bar.
- Return to Now.
- Finance support.
- All write actions disabled globally.
- Developer event action: `View app at this event`.

Defer:

- Dynamic entity historical schema.
- Calendar support.
- Historical invoice export.
- Local-only history based on `local_sequence`.
- Side-by-side comparison.
