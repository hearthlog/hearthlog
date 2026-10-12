# iPhone builds without a paid developer account

A free Apple ID can sign the iPhone app from Xcode, but the profile expires after seven days and the
app then refuses to open. `pnpm apple:resign` rebuilds each site with a fresh profile and installs it
over the old copy, which keeps the app's data. A LaunchAgent can run it every night.

The app itself, the per-site setup and the Mac app are described in `docs/native-shell.md`.

## Free account limits

- Profiles last seven days.
- At most three free-signed apps on one device, so at most three sites.
- At most ten new app IDs per seven days.
- No push notifications, App Groups or app extensions. Local notifications (the app's reminders) work.
- The bundle id must be unique across Apple: if `app.stor.<site>` is taken, set your own `bundlePrefix`.

## One-time setup

1. Install Xcode and select it: `sudo xcode-select -s /Applications/Xcode.app`.
2. In Xcode › Settings › Accounts, add your Apple ID. It appears as a Personal Team.
3. Run `pnpm apple:ios <site>`, open `.apple-build/project/Stor.xcodeproj`, choose your Personal Team under
   Signing & Capabilities, and run the "Stor iOS" scheme on your iPhone once. That creates your
   development certificate and registers the device. Turn on Settings › Privacy & Security › Developer
   Mode on the iPhone first, and trust your Apple ID under Settings › General › VPN & Device
   Management after the first launch. Running `pnpm apple:ios <site>` again then finds the team itself.
4. In Xcode's Devices window, turn on **Connect via network**, so later installs need no cable.
5. Copy `packages/native/resign.example.json` to `resign.local.json` at the tenant root (git-ignored) and set `device` to the
   iPhone's name and `sites` to the site ids (site ids are in `tenants.json`, for example `st`, `alpha`).
   Optional: `team` (found from your certificate when left out), `bundlePrefix`, `renewWithinDays`.

## Commands

```bash
pnpm apple:resign status     # days left per site
pnpm apple:resign            # prepare, rebuild and install sites with under 2 days left
pnpm apple:resign --force    # prepare, rebuild and install every site now
pnpm apple:resign install    # run daily at 03:30 (LaunchAgent `<bundlePrefix>.resign`, one per tenant)
pnpm apple:resign uninstall  # stop the daily run
```

The daily run does nothing until a site is due, so it rebuilds roughly every five days. The Mac must
be logged in; a run missed during sleep happens on the next wake. The iPhone must be on the same
network and unlocked at least once since it restarted. Each run logs to
`~/Library/Logs/stor-resign.log` and shows a macOS notification on success or failure.

Each site is prepared first (`packages/native/src/ios.ts`: its Info.plist, icon, bundle id and team, then
the project), built into `.apple-build/ios/<site>`, and installed with `devicectl`.

Xcode reuses a cached profile until it expires, so before rebuilding a due site the script removes
only the Xcode-managed team profiles for that bundle id. It then checks that the new build's profile
has at least six days left.

Deleting the app from the iPhone deletes its local database and any unsent changes. Reinstalling over
it, as this script does, keeps them.
