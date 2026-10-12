#!/usr/bin/env npx tsx
/**
 * Keep free-signed iPhone builds alive. Profiles from a free Apple ID (Xcode
 * "Personal Team") expire after seven days; this rebuilds each site with a fresh
 * profile and installs it over the old copy, which keeps the app's data.
 *
 * Usage:
 *   hearthlog apple:resign             rebuild and install sites whose profile expires soon
 *   hearthlog apple:resign --force     rebuild and install every site now
 *   hearthlog apple:resign --dry-run   report what is due without building
 *   hearthlog apple:resign status      show each site's installed profile expiry
 *   hearthlog apple:resign install     run daily at 03:30 through a LaunchAgent
 *   hearthlog apple:resign uninstall   remove the LaunchAgent
 *
 * Settings live in resign.local.json (git-ignored); see resign.example.json (in
 * @hearthlog/native). Each site's app is prepared first
 * (ios.ts), so a build always carries that site's bundle id, icon and team.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { prepareIosSite } from "./ios.js";
import {
    AppleError as ResignError,
    BUILD_ROOT as APPLE_BUILD_ROOT,
    loadAppleSettings,
    loadAppleSite,
    run,
    type AppleSettings,
} from "./site.js";
import { REPOSITORY_ROOT } from "@hearthlog/tooling/tenants/tenant-config.js";

interface InstallState {
    bundleId: string;
    expiresAt: string;
    installedAt: string;
}

interface ProvisioningProfile {
    file: string;
    name: string;
    applicationIdentifier: string;
    expiresAt: Date;
}

const DAY_MS = 86_400_000;
const BUILD_ROOT = path.join(APPLE_BUILD_ROOT, "ios");
/** One agent per tenant: the label follows the bundle prefix, so tenant repositories never share one. */
const labelFor = (settings: AppleSettings) => `${settings.bundlePrefix}.resign`;
const launchAgentFor = (settings: AppleSettings) => path.join(homedir(), "Library", "LaunchAgents", `${labelFor(settings)}.plist`);
const logFileFor = (settings: AppleSettings) => path.join(homedir(), "Library", "Logs", `${labelFor(settings)}.log`);
/** Xcode 16 keeps managed profiles in the first folder; older versions used the second. */
const PROFILE_DIRECTORIES = [
    path.join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
    path.join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
];

function log(message: string) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function notify(title: string, message: string) {
    const quote = (value: string) => JSON.stringify(value);
    spawnSync("osascript", ["-e", `display notification ${quote(message)} with title ${quote(title)}`]);
}

function requireXcode() {
    const developerDirectory = run("xcode-select", ["-p"], { quiet: true }).trim();
    if (developerDirectory.includes("CommandLineTools")) {
        throw new ResignError("Xcode is required. Install it, then run: sudo xcode-select -s /Applications/Xcode.app");
    }
}

/** devicectl and xcodebuild both accept the hardware UDID, so resolve names to it. */
function resolveDevice(device: string): { udid: string; name: string } {
    const output = path.join(BUILD_ROOT, "devices.json");
    mkdirSync(BUILD_ROOT, { recursive: true });
    run("xcrun", ["devicectl", "list", "devices", "--json-output", output], { quiet: true });
    const listing = JSON.parse(readFileSync(output, "utf8")) as {
        result?: { devices?: Array<{ hardwareProperties?: { udid?: string; platform?: string }; deviceProperties?: { name?: string } }> };
    };
    for (const candidate of listing.result?.devices ?? []) {
        const udid = candidate.hardwareProperties?.udid;
        const name = candidate.deviceProperties?.name;
        if (udid && (udid === device || name === device)) return { udid, name: name ?? udid };
    }
    throw new ResignError(`No paired device named "${device}". Pair it once in Xcode and turn on "Connect via network".`);
}

/** Read one value; profiles hold binary data that a whole-file JSON conversion rejects. */
function plistValue(keyPath: string, file: string, input?: string): string {
    return run("plutil", ["-extract", keyPath, "raw", "-o", "-", input === undefined ? file : "-"], { input, quiet: true }).trim();
}

/** Profiles are CMS-signed plists; security decodes them to XML first. */
function readProfile(file: string): ProvisioningProfile | null {
    try {
        const xml = run("security", ["cms", "-D", "-i", file], { quiet: true });
        const expiresAt = new Date(plistValue("ExpirationDate", file, xml));
        if (Number.isNaN(expiresAt.getTime())) return null;
        return {
            file,
            name: plistValue("Name", file, xml),
            applicationIdentifier: plistValue("Entitlements.application-identifier", file, xml),
            expiresAt,
        };
    } catch {
        return null;
    }
}

/**
 * Xcode reuses a cached profile until it expires, so a rebuild two days early would
 * install a build that still dies on the old date. Remove only the Xcode-managed
 * team profiles for this bundle id; Xcode downloads a fresh seven-day one.
 */
function removeCachedProfiles(bundleId: string) {
    for (const directory of PROFILE_DIRECTORIES) {
        if (!existsSync(directory)) continue;
        for (const entry of readdirSync(directory)) {
            if (!entry.endsWith(".mobileprovision")) continue;
            const profile = readProfile(path.join(directory, entry));
            if (!profile) continue;
            const managed = profile.name.startsWith("iOS Team Provisioning Profile:");
            if (managed && profile.applicationIdentifier.endsWith(`.${bundleId}`)) {
                rmSync(profile.file);
                log(`Removed cached profile ${entry} for ${bundleId}`);
            }
        }
    }
}

function statePath(site: string) {
    return path.join(BUILD_ROOT, site, "installed.json");
}

function readState(site: string): InstallState | null {
    try {
        return JSON.parse(readFileSync(statePath(site), "utf8")) as InstallState;
    } catch {
        return null;
    }
}

function daysLeft(state: InstallState | null, now: number) {
    return state ? (Date.parse(state.expiresAt) - now) / DAY_MS : -Infinity;
}

function buildSite(settings: AppleSettings, site: string, udid: string): { app: string; bundleId: string; expiresAt: Date } {
    const derivedData = path.join(BUILD_ROOT, site);
    run("xcodebuild", [
        "-project", settings.project,
        "-scheme", settings.scheme,
        "-configuration", "Release",
        "-destination", `platform=iOS,id=${udid}`,
        "-derivedDataPath", derivedData,
        "-allowProvisioningUpdates",
        "-allowProvisioningDeviceRegistration",
        "-quiet",
        "build",
    ]);
    const products = path.join(derivedData, "Build", "Products", "Release-iphoneos");
    const app = readdirSync(products).find((entry) => entry.endsWith(".app"));
    if (!app) throw new ResignError(`No .app in ${products}`);
    const appPath = path.join(products, app);
    const bundleId = plistValue("CFBundleIdentifier", path.join(appPath, "Info.plist"));
    if (!bundleId) throw new ResignError(`${app} has no bundle identifier`);
    const profile = readProfile(path.join(appPath, "embedded.mobileprovision"));
    if (!profile) throw new ResignError(`${app} has no readable provisioning profile`);
    return { app: appPath, bundleId, expiresAt: profile.expiresAt };
}

async function installWithRetry(udid: string, app: string) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            run("xcrun", ["devicectl", "device", "install", "app", "--device", udid, app], { quiet: true });
            return;
        } catch (error) {
            if (attempt === 3) throw error;
            log(`Install attempt ${attempt} failed; retrying in a minute (is the iPhone on this network?)`);
            await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
    }
}

async function resign({ force, dryRun }: { force: boolean; dryRun: boolean }) {
    const settings = loadAppleSettings({ requireDevice: true });
    // An unknown site id should fail now, not halfway through a build.
    for (const site of settings.sites) await loadAppleSite(site, settings);
    const now = Date.now();
    const due = settings.sites.filter((site) => force || daysLeft(readState(site), now) < settings.renewWithinDays);
    for (const site of settings.sites) {
        const left = daysLeft(readState(site), now);
        log(`${site}: ${Number.isFinite(left) ? `${left.toFixed(1)} days left` : "not installed by this script"}${due.includes(site) ? ", due" : ""}`);
    }
    if (due.length === 0 || dryRun) return;

    requireXcode();
    const device = resolveDevice(settings.device);
    const renewed: string[] = [];
    for (const site of due) {
        const definition = await loadAppleSite(site, settings);
        removeCachedProfiles(definition.bundleId);
        log(`${site}: preparing ${definition.bundleId}, then building for ${device.name}`);
        await prepareIosSite(definition, settings, { requireTeam: true });
        const build = buildSite(settings, site, device.udid);
        if (build.expiresAt.getTime() - Date.now() < 6 * DAY_MS) {
            throw new ResignError(`${site}: Xcode signed with a profile that expires ${build.expiresAt.toISOString()}; remove it from Xcode's profile folder and run with --force.`);
        }
        await installWithRetry(device.udid, build.app);
        const state: InstallState = { bundleId: build.bundleId, expiresAt: build.expiresAt.toISOString(), installedAt: new Date().toISOString() };
        writeFileSync(statePath(site), `${JSON.stringify(state, null, 4)}\n`);
        log(`${site}: installed ${build.bundleId}, runs until ${build.expiresAt.toLocaleString()}`);
        renewed.push(site);
    }
    notify("stor re-signed", `${renewed.join(", ")} installed on ${device.name} for another 7 days.`);
}

function launchAgentPlist(settings: AppleSettings) {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    // The PATH entry survives `brew upgrade node`; process.execPath points into a versioned Cellar folder.
    const node = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim() || process.execPath;
    // The tenant's installed `hearthlog` bin runs the command (and the build before it) the way a terminal does.
    const bin = path.join(path.dirname(createRequire(path.join(REPOSITORY_ROOT, "package.json")).resolve("@hearthlog/tooling/package.json")), "bin", "hearthlog.mjs");
    const programArguments = [node, bin, "apple:resign"];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${labelFor(settings)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments.map((argument) => `        <string>${escape(argument)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key><string>${escape(REPOSITORY_ROOT)}</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string></dict>
    <!-- Missed runs during sleep fire on the next wake. -->
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
    <key>StandardOutPath</key><string>${escape(logFileFor(settings))}</string>
    <key>StandardErrorPath</key><string>${escape(logFileFor(settings))}</string>
</dict>
</plist>
`;
}

function installAgent() {
    const settings = loadAppleSettings({ requireDevice: false });
    const agent = launchAgentFor(settings);
    mkdirSync(path.dirname(agent), { recursive: true });
    writeFileSync(agent, launchAgentPlist(settings));
    const domain = `gui/${userInfo().uid}`;
    spawnSync("launchctl", ["bootout", `${domain}/${labelFor(settings)}`]);
    run("launchctl", ["bootstrap", domain, agent]);
    log(`Installed ${agent}; runs daily at 03:30, log at ${logFileFor(settings)}`);
}

function uninstallAgent() {
    const settings = loadAppleSettings({ requireDevice: false });
    spawnSync("launchctl", ["bootout", `gui/${userInfo().uid}/${labelFor(settings)}`]);
    rmSync(launchAgentFor(settings), { force: true });
    log(`Removed ${launchAgentFor(settings)}`);
}

const args = process.argv.slice(2);
try {
    if (args[0] === "install") installAgent();
    else if (args[0] === "uninstall") uninstallAgent();
    else if (args[0] === "status") await resign({ force: false, dryRun: true });
    else await resign({ force: args.includes("--force"), dryRun: args.includes("--dry-run") });
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed: ${message}`);
    notify("stor re-sign failed", message);
    process.exitCode = 1;
}
