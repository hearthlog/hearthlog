# Log history and forking

The active-log control opens one side panel. Its title is the current log's name, and a path above the switch names the logs it came from; choosing an ancestor opens it. **History | Logs** switches the panel's content without changing its title, and **Copy this log** is always beside it. The panel floats over the page.

## History

A map above the list works as a minimap of the current log. Each log is a line on a shared time axis that starts where it forked; the current log is the thick line. Every action is a point: its own actions on its line, copied ones on the source's line. Hovering a point shows the action's name and time, and how many others share the spot; choosing it opens that action in the list. A shaded band marks the part of the list on screen. Dragging along the map moves the list to the action nearest in time, loading older actions as needed, and the wheel over the map scrolls the list. Choosing another log's line opens that log. The map covers the last month, or back to the oldest fork within four months; older logs run in from the left edge, and its points come from one SQL read of the actions in that range (at most 3,000).

The newest-first list groups complete actions, with date headings, recognizable record names, feature icons, search, and a feature filter. Records without a name read as their main value, such as **Weight 81.2 kg**. The list loads further actions as you scroll; there is no **Load older actions** button. Search matches any member of an action; filtering never splits an action.

Two kinds of cards sit between actions:

- **Starts here** marks where a fork began: it names the source and the time of the last copied action, and the source opens from it. Actions below the card were copied from the source and read lighter.
- **Started here** marks where another log branched off: a fork of this log, or a fork of an ancestor taken within the part this log shares. It shows the log's own changes and last use, and opens that log.

Cards are left out while searching or filtering. All selection, filtering, ordering, card positions, counting, and field comparison run in SQLite through the scoped history repository; the browser only passes the fork points from the cached log list as bound values.

Choosing a row opens it in place. Synced actions show changed fields as before and after values. Pending, incomplete, and troubled actions remain inspectable: their locally saved payload values are labelled as unconfirmed. **Needs attention** links to sync issues. Version and event identifiers are in **Technical details**. Browsing and inspecting downloaded history works offline. The open row, the fork step, search, filter and panel tab live in shallow URL state, so Back, Forward and reload keep the view.

## Logs

The Logs view is the fork tree: independent logs are roots, and forks sit beneath their source. Each level indents once up to the third; deeper forks stop indenting and name their source. Each log shows where it came from, its own changes (head version minus fork version) and its last change. The current log has the raised selection and **Current**. Choosing a ready log switches this device; a preparing fork waits.

**Hide** removes a log from the tree, the map and the history cards, with Undo. **Show hidden** in the footer lists them again with a **Show** action. Hiding is stored by Ledger (`hidden_at`) and changes nothing else: a hidden log keeps its events and forks and can still be opened. The current log cannot be hidden. **New empty log** starts a separate root.

## Create a fork

1. Open an action and choose **New log after this**, or choose **Copy this log** to start after the newest synced action. A dashed **New log starts here** card marks the gap where the new log begins; it keeps everything below it.
2. The footer suggests the root log's name and the day of that action, numbered when the name is taken, and states what is kept: **Keeps 25 actions. Leaves out 1 newer one.** The count includes all domains, even ones outside the current filter or disabled features. This copies the entire log up to that point; it never restores just one record. The original log stays unchanged.
3. Choose **Create and switch**. Creation requires an online, synchronized log. A changed head asks for a fresh check. Retries of an unchanged request reuse its request ID; changing the name or the starting action creates a distinct request.
4. Ledger atomically creates a `preparing` child with copied events through the selected boundary, preserving IDs, versions, grouping and payloads, and rebuilding entity claims. The frontend Worker copies referenced uploaded invoice PDFs and ISDOC files to keys scoped to the child. Missing required files keep the fork unavailable. Generated invoice PDF caches rebuild on demand.
5. Once files are ready, this device switches, downloads the child history, and projects its read model. Progress stays in the footer. The success notification names the opened log and offers **Open original log**. Other devices keep their own active-log selection.

Starting a log from a copied action makes it a child of the current log, with the same content as forking the source at that point. A source with child forks cannot be deleted in Developer; this preserves the lineage. Forking duplicates the accepted event prefix and its referenced private files, so storage and first download grow with the source history.

## Compatibility

The global Undo, whole-log restore, event-removal, and app-wide historical browsing controls are retired. Old `/history` and `asOfVersion` links return to their source page and open the panel with the corresponding action open. Old `historyLimit` and `historySide` parameters are ignored. Ordinary edits, archives, and record deletions remain events in the current log.

Normal pages use one live tenant/log read session. History reads accepted action boundaries from the active log; Ledger validates and copies the selected accepted prefix when a fork is created. New client commands for legacy tombstone, restore, and excision events are rejected. The replay interpreter remains for previously accepted events and offline outbox delivery.

Existing `EVENT_TOMBSTONED`, `WORKSPACE_RESTORED`, and `EVENTS_EXCISED` events remain in old logs and copied prefixes. Their replay code is still required. Ledger currently accepts new legacy directives for older clients and already queued outbox work. Blocking those appends requires a later client-version gate and migration for pending old-client operations; silently rejecting them would strand offline edits.

The logical event backup preserves event history and fork lineage when restored into a new application. Old exports without lineage remain restorable. External R2 files are not part of the logical event archive; use an R2 backup when those files must remain accessible in another application.

The fork SQL copy is atomic within one Ledger Durable Object. File preparation is a separate resumable step; a child is not selectable until it completes. Large source histories have not yet been benchmarked against Durable Object request limits, so measure real log sizes before declaring a maximum supported fork size.
