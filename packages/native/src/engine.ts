#!/usr/bin/env npx tsx
/**
 * Build the engine check app for one site: a window that shows what the hidden engine web view
 * reports (milestone 1 of the native apps; see swift/Engine). Command Line Tools only, like apple:mac.
 *
 * Usage:
 *   hearthlog apple:engine <site>          build .apple-build/engine/<site>/<title> Engine.app
 *   hearthlog apple:engine <site> --dev    debugging aids; STOR_ORIGIN can point at a dev server
 *   hearthlog apple:engine <site> --open   open the app once built
 *
 * It uses the site's data store, so it opens the same local database as the Mac shell.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SWIFT_DIRECTORY, AppleError, BUILD_ROOT, loadAppleSettings, loadAppleSite, macInfoPlist, run } from "./site.js";

const DEPLOYMENT_TARGET = "14.0";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const siteId = args.find((arg) => !arg.startsWith("--"));

/** The engine, the demo window, and the shell parts they share: site settings, navigation rules, sign-in. */
function engineSources(): string[] {
    return [
        path.join("Shared", "SiteConfig.swift"),
        path.join("Shared", "NavigationPolicy.swift"),
        path.join("Engine", "EngineProtocol.swift"),
        path.join("Engine", "HearthlogEngine.swift"),
        path.join("macOS", "SignInWindowController.swift"),
        path.join("EngineDemo", "EngineDemoApp.swift"),
    ].map((file) => path.join(SWIFT_DIRECTORY, file));
}

async function main() {
    if (!siteId) throw new AppleError("Usage: hearthlog apple:engine <site> [--dev] [--open]");
    const development = flags.has("--dev");
    const site = await loadAppleSite(siteId, loadAppleSettings({ requireDevice: false }));
    // Never the shell's bundle: the two apps keep their own windows, settings and permissions.
    site.bundleId = `${site.bundleId}.engine${development ? ".dev" : ""}`;

    const fileName = `${site.title.replace(/[^\w .-]/g, "")} Engine${development ? "-dev" : ""}`;
    const directory = path.join(BUILD_ROOT, "engine", `${site.id}${development ? "-dev" : ""}`);
    const app = path.join(directory, `${fileName}.app`);
    rmSync(app, { recursive: true, force: true });
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });

    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const sdk = run("xcrun", ["--show-sdk-path"], { quiet: true }).trim();
    run("swiftc", [
        "-swift-version", "5",
        "-parse-as-library",
        ...(development ? ["-Onone", "-g", "-DSTOR_DEV"] : ["-O", "-wmo"]),
        "-target", `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
        "-sdk", sdk,
        "-module-name", "StorEngine",
        "-o", path.join(app, "Contents", "MacOS", fileName),
        ...engineSources(),
    ]);
    writeFileSync(path.join(app, "Contents", "Info.plist"), macInfoPlist(site, { executable: fileName, development, inspectable: development }));
    writeFileSync(path.join(app, "Contents", "PkgInfo"), "APPL????");

    const identity = process.env.STOR_SIGN_IDENTITY || "-";
    run("codesign", ["--force", "--sign", identity, "--identifier", site.bundleId, "--timestamp=none", app], { quiet: true });
    console.log(`Built ${path.relative(process.cwd(), app)} (${arch}, signed ${identity === "-" ? "ad hoc" : `as ${identity}`}).`);
    if (flags.has("--open") && existsSync(app)) run("open", [app]);
}

try {
    await main();
} catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
