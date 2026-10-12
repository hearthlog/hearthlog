# Native Mac and iOS apps

Each site can be installed as a Mac app and an iPhone/iPad app. The app is a thin Swift shell around
a `WKWebView` that opens the **deployed site**, so Access, the Ledger gateway, the local SQLite
database in OPFS, the outbox and the service worker are exactly what the browser runs. A web deploy
updates the app; there is no second release for UI. The browser version is unchanged: everything
native is behind `window.storShell`, which only the shells define.

The design study (screenshots, alternatives, decisions) is in
`docs/design-concepts/native-shell-2026-10-03/`.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/native/swift/Shared/` | Web view host, navigation rules, bridge messages, reminder scheduling (Mac and iOS) |
| `packages/native/swift/macOS/` | AppKit app: window, glass, window buttons, menus, sign-in window, dev aids |
| `packages/native/swift/iOS/` | UIKit app: scene, view controller, sign-in sheet, background time |
| `packages/native/swift/Tests/` | Swift checks for the rules that decide access and scheduling (`pnpm apple:test`) |
| `.apple-build/project/` | The iOS project and its per-site files, generated into the tenant and git-ignored (`pnpm apple:ios <site>`) |
| `packages/runtime/src/native/` | The page's side of the bridge: `shell.ts` (messages), `shell.svelte.ts` (wiring), `reminders.ts` (the reminder hour) |
| `packages/native/src/` | Build, project generation, icons and the weekly re-sign (`@hearthlog/native`, run as `hearthlog apple:mac`, `apple:ios`, `apple:test`, `apple:resign`) |

One app per site. Its name, accent, icon, bundle id (`<bundlePrefix>.<site id>`) and origin come
from `tenants.json` and `resign.local.json` at the tenant root; its data store is private to the site.

In a tenant repository, add `@hearthlog/native` to the dependencies (and `@playwright/test`, which renders the
icons) and run `pnpm exec hearthlog apple:mac <site>`; the `pnpm apple:*` scripts below are this repository's
shortcuts for the same commands. The Swift sources stay in the package, and everything generated (the apps,
the iOS project, icons) goes to the tenant's `.apple-build/`, which the site template git-ignores with
`resign.local.json`.

## Mac

```bash
pnpm apple:mac alpha                 # .apple-build/mac/alpha/alpha.app
pnpm apple:mac alpha --dmg           # also .apple-build/dist/alpha-<version>.dmg
pnpm apple:mac alpha --universal     # Apple silicon and Intel
pnpm apple:mac --all --dmg          # every site
pnpm apple:mac alpha --open
```

It needs only the Command Line Tools (`swiftc`, `codesign`, `hdiutil`, `iconutil`), no Xcode. The app
is signed ad hoc, so a copy that arrives by download or AirDrop needs right-click › Open once (or
System Settings › Privacy & Security › Open Anyway); it cannot be notarized without a paid
Apple Developer account. Camera and notification permissions belong to the signature, so an ad hoc
rebuild asks again; set `STOR_SIGN_IDENTITY` to a certificate in your keychain (a self-signed code
signing certificate works) to keep them.

What the Mac app does:

- **Window.** No title bar of its own: the content runs under it and the window buttons sit on the
  sidebar's header row. The row shows no brand in the Mac app — the menu bar already names it — and
  the empty `[data-stor-lights]` anchor there reserves the buttons' space. The shell measures the
  buttons and tells the page how much room they need
  (`window.storShell.lights`), so it holds across macOS versions. If AppKit resets their frames when
  switching apps, the shell restores the group after that layout finishes, without a reload or resize.
  Live resizing restores them in each resize callback, so they stay in the sidebar while the mouse is held.
- **Glass.** The web view is transparent over an `NSVisualEffectView`. In `app.css`
  (`html[data-stor-shell="mac"]`) one canvas tint at 86% covers the whole app, including the space
  behind the floating sidebar. The sidebar adds its translucent surface over that shared background.
- **Dragging.** Clicking the page's background moves the window: the sidebar's empty space and header
  row, the gaps between panels, empty header space, panel padding and the glass around the sidebar.
  Links, buttons, fields, text, graphics and anything clickable keep working, and nothing drags while
  a dialog or drawer is open, so clicking outside it still closes it. The shell injects this
  (`apple/Shared/WindowDragScript.swift`), so it works with whichever version of the page is deployed;
  `data-stor-drag` marks areas that drag even over text and `data-stor-no-drag` areas that never do.
  A double click zooms or minimizes as System Settings says.
- **Menus.** File's create shortcuts and Go's sections come from the page (`menu` message), built
  from the feature registry and the routes that already exist. ⌘N and ⇧⌘N are the first two creates,
  ⌘1–9 the sections, ⌃⌘S toggles the sidebar, ⌥⌘N opens another window.
- **Dock menu.** Right-clicking the app's Dock icon lists every available page from the same
  `menu` message, a section's sub-pages in a submenu, then New Window. Picking one opens it in the
  active window, or in a new one when none is open.
- **Dock badge** is the overdue-invoice count. Quitting with changes still waiting to upload asks first.
- **Files.** `<input type="file">` opens a panel; downloads and `<a download>` open a save panel;
  `window.open` of the app's own pages (the PDF viewers) opens a window; other sites open in the
  default browser.

## iPhone and iPad

The iOS app needs Xcode and an Apple ID. A free Apple ID works (see
`docs/ios-free-signing.md` for its limits and the weekly re-sign).

```bash
pnpm apple:ios alpha                 # writes .apple-build/project/
open .apple-build/project/Stor.xcodeproj          # run the "Stor iOS" scheme
pnpm apple:resign --force           # or build and install over the network (needs resign.local.json)
```

`apple:ios` finds your team id from the Apple Development certificate Xcode created (set `team` in
`resign.local.json` at the tenant root if you have several). The project is regenerated on every run, so adding
a Swift file needs no project edit.

- **Edge to edge.** The boot script adds `viewport-fit=cover` in the iOS shell only; the page's
  existing `env(safe-area-inset-*)` rules do the rest. The header and the dock are translucent
  (`html[data-stor-shell="ios"]`); both stay web, so drawers and sheets slide over them as before.
- **Service worker.** WKWebView only runs one on iOS for App-Bound Domains. The generated
  Info.plist lists the site's host in `WKAppBoundDomains` and the web view limits its navigation to it.
- **Downloads** go to a temporary file and leave through the share sheet (Save to Files).
- **Haptics** on `notify.success` and `notify.error`. **Background time**: while changes are still
  waiting to upload, leaving the app asks iOS for extra time so the page's retry loop can finish.
- Portrait only on iPhone; iPad turns freely.

## Sign-in

When Cloudflare Access wants a login, the page navigates to the Access team host. The shell cancels
that navigation, so the page and its form state stay as they are, and opens the login in its own
window (Mac) or sheet (iOS). That view shares the app's data store, so the session cookie Access sets
is the one the app sends. When Access sends it back to the app, past `/cdn-cgi/`, the window closes
and the app reloads signed in. Sessions last seven days (`accessSessionDuration`).

The login runs in an embedded web view, which some identity providers refuse: Google answers
`disallowed_useragent`. Enable **One-time PIN** (or GitHub) on the Access application for the sites
you install.

## What crosses the bridge

The page posts `{ type, body }` to the `stor` script message handler; only the main frame of the
app's own origin is accepted, and malformed messages are dropped. Nothing but small values the page
already shows crosses it: no events, rows, files or credentials.

| Page to shell | Body | Used for |
| --- | --- | --- |
| `appearance` | `preference`, `resolved`, `background` | native chrome follows the page's theme |
| `badge` | `count` | app icon badge |
| `reminders` | `items[{ id, title, body, at, path }]` | replaces the scheduled local notifications |
| `menu` | `destinations[]` (with optional `children[]` sub-pages), `actions[]` (`id`, `title`, `path`) | Mac menus and the Dock menu |
| `lights` | `x`, `y` | where the window buttons belong (Mac) |
| `outbox` | `pending` | iOS background time, Mac quit warning |
| `haptic` | `kind` | iOS feedback |
| `backgroundHover` | `on` | sent by the shell's own script, not the page: the pointer is over a background, so a click there moves the window (Mac) |

Shell to page: `window` event `stor-shell` with `{ type: 'navigate', path }`,
`{ type: 'toggle-sidebar' }` or `{ type: 'resume' }`, plus `data-stor-inactive` and
`data-stor-fullscreen` attributes on `<html>`. Routes are accepted only when they start with a single `/`.

## Reminders

The page plans them after every event change, log switch, wake and once data opens, from SQL through each module's attention contribution
(`modules/invoices/src/attention.ts`, `modules/finance/src/attention.ts`; `attention` in the manifest), and the shell replaces the device's pending notifications with the list.

- An issued, unpaid invoice reminds at 09:00 the day before it is due and at 09:00 on its due date.
- Plans (active transactions) collapse into one note per day at 09:00: the next 14 days.
- Times already past are dropped; at most 60 are kept (iOS keeps 64).
- Permission is asked the first time there is something to schedule. Tapping a reminder opens
  `/invoices` or `/finance`.

Reminders live on the device, so a reminder for something paid or confirmed on another device stays
until the app is opened and re-plans. The Mac reminds only while the app is running.

## Development

`pnpm apple:mac <site> --dev` builds a flavor with debugging aids, never in a release:

| Variable | Effect |
| --- | --- |
| `STOR_ORIGIN` | open this origin, for example `http://127.0.0.1:5180` (own data store) |
| `STOR_ACCESS_HOST` | treat this host as the Access login |
| `STOR_DEV_LEGACY_PAGE=1` | do not define `window.storShell`, as a page that predates the shell sees it |
| `STOR_DEV_EVAL`, `STOR_DEV_EVAL_FILE` | run an async JavaScript function body in the page, print `EVAL <value>` |
| `STOR_DEV_NAVIGATE` | open a route through the shell, as the Go menu does |
| `STOR_DEV_SCREENSHOT`, `STOR_DEV_DELAY`, `STOR_DEV_SETTLE`, `STOR_DEV_EXIT` | write a PNG of the window, with timing and quit |
| `STOR_DEV_NO_NOTIFICATIONS=1` | log reminders instead of scheduling them (scheduling asks for permission) |

Start the app with `open -n -W --env KEY=VALUE … --stdout out.txt <app>` so it activates; a process
started from a shell stays inactive and its page never paints. `pnpm apple:test` runs the Swift
checks.

## Status

Run in the Mac app on macOS 27, against the dev server and a production build:

- the window, glass, window buttons, light and dark, the menus built from the page, the Dock badge,
  and reminders arriving from real data (logged, not scheduled);
- window-button alignment after repeated app switches, with the sidebar expanded and collapsed,
  during live resizing, and after entering and leaving fullscreen;
- the sign-in window against a fake Access, including the shared session cookie;
- a blob `<a download>` saved to disk, and `window.open` of a blob page (the PDF viewers);
- the service worker, the OPFS database (sync access handles in a worker) and an offline cold start
  from the service worker cache with the origin and the Ledger both down.

Checked by `pnpm apple:test`: the navigation rules, message parsing and reminder planning.

Not exercised: the iOS app (it is type-checked through the Mac Catalyst SDK, and its Xcode project is
validated structurally, but it has not been built or run, because Xcode is not installed here), the
file and save panels, window dragging, the Dock menu itself (its items are printed by the debugging
aids), menu clicks, the camera, delivery of a scheduled notification, the quit warning, and the DMG on
another Mac. iPad windowed mode (window controls over the rail) is not handled. Share-in (Open in), the
Photos picker that keeps GPS, and Dock drops are not built.
