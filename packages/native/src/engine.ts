#!/usr/bin/env npx tsx
/**
 * Build the engine check app for one site: a window that shows what the hidden engine web view
 * reports (milestone 1 of the native apps; see swift/Engine). Command Line Tools only, like apple:mac.
 *
 * Usage:
 *   hearthlog apple:engine <site>                 build .apple-build/engine/<site>/<title> Engine.app
 *   hearthlog apple:engine <site> --app <dir>     build the native app whose Swift is in <dir> instead
 *                                                 (for example modules/stash/apple: <title> Stash.app)
 *   hearthlog apple:engine <site> --mpv           also build the libmpv player (swift/Media), for an app that plays
 *                                                 video; libmpv comes from Homebrew (`brew install mpv`)
 *   hearthlog apple:engine <site> --dev           debugging aids; STOR_ORIGIN can point at a dev server
 *   hearthlog apple:engine <site> --open          open the app once built
 *
 * It uses the site's data store, so it opens the same local database as the Mac shell.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SWIFT_DIRECTORY, AppleError, BUILD_ROOT, loadAppleSettings, loadAppleSite, macInfoPlist, run } from "./site.js";

const DEPLOYMENT_TARGET = "14.0";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const appDirectory = args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined;
const siteId = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--app");

/** Every Swift file under `directory`, in a stable order. */
function swiftFiles(directory: string): string[] {
    return readdirSync(directory, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".swift"))
        .sort()
        .map((file) => path.join(directory, file));
}

/** The engine and the shell parts it shares (site settings, navigation rules, sign-in), the player, then the app's own Swift. */
function sources(app: string, mpv: boolean): string[] {
    return [
        path.join(SWIFT_DIRECTORY, "Shared", "SiteConfig.swift"),
        path.join(SWIFT_DIRECTORY, "Shared", "NavigationPolicy.swift"),
        path.join(SWIFT_DIRECTORY, "macOS", "SignInWindowController.swift"),
        ...swiftFiles(path.join(SWIFT_DIRECTORY, "Engine")),
        ...(mpv ? swiftFiles(path.join(SWIFT_DIRECTORY, "Media")) : []),
        ...swiftFiles(app),
    ];
}

/** Compiler and linker flags for libmpv, from its pkg-config file (Homebrew installs one). */
function mpvFlags(): string[] {
    let output: string;
    try {
        output = run("pkg-config", ["--cflags", "--libs", "mpv"], { quiet: true });
    } catch {
        throw new AppleError("--mpv needs libmpv and pkg-config: brew install mpv pkg-config");
    }
    const flags = output.trim().split(/\s+/).filter(Boolean).flatMap((flag) => {
        if (flag.startsWith("-I") || flag.startsWith("-D")) return ["-Xcc", flag];
        if (flag.startsWith("-L") || flag.startsWith("-l")) return [flag];
        return [];
    });
    return [...flags, "-Xcc", "-DGL_SILENCE_DEPRECATION", "-import-objc-header", path.join(SWIFT_DIRECTORY, "Media", "MPVBridging.h")];
}

async function main() {
    if (!siteId || (args.includes("--app") && !appDirectory)) throw new AppleError("Usage: hearthlog apple:engine <site> [--app <dir>] [--mpv] [--dev] [--open]");
    const app = appDirectory ? path.resolve(appDirectory) : path.join(SWIFT_DIRECTORY, "EngineDemo");
    if (!existsSync(app)) throw new AppleError(`${app} does not exist`);
    // The app's name: "Engine" for the check window, else its folder's parent (modules/stash/apple: Stash).
    const name = appDirectory ? path.basename(path.basename(app) === "apple" ? path.dirname(app) : app).replace(/^\w/, (letter) => letter.toUpperCase()) : "Engine";
    const development = flags.has("--dev");
    const site = await loadAppleSite(siteId, loadAppleSettings({ requireDevice: false }));
    // Never the shell's bundle: the two apps keep their own windows, settings and permissions.
    site.bundleId = `${site.bundleId}.${name.toLowerCase()}${development ? ".dev" : ""}`;

    const fileName = `${site.title.replace(/[^\w .-]/g, "")} ${name}${development ? "-dev" : ""}`;
    const directory = path.join(BUILD_ROOT, name.toLowerCase(), `${site.id}${development ? "-dev" : ""}`);
    const bundle = path.join(directory, `${fileName}.app`);
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });

    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const mpv = flags.has("--mpv");
    const sdk = run("xcrun", ["--show-sdk-path"], { quiet: true }).trim();
    run("swiftc", [
        "-swift-version", "5",
        "-parse-as-library",
        ...(development ? ["-Onone", "-g", "-DSTOR_DEV"] : ["-O", "-wmo"]),
        "-target", `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
        "-sdk", sdk,
        "-module-name", `Stor${name}`,
        "-o", path.join(bundle, "Contents", "MacOS", fileName),
        ...(mpv ? mpvFlags() : []),
        ...sources(app, mpv),
    ]);
    writeFileSync(path.join(bundle, "Contents", "Info.plist"), macInfoPlist(site, { executable: fileName, development, inspectable: development }));
    writeFileSync(path.join(bundle, "Contents", "PkgInfo"), "APPL????");

    const identity = process.env.STOR_SIGN_IDENTITY || "-";
    run("codesign", ["--force", "--sign", identity, "--identifier", site.bundleId, "--timestamp=none", bundle], { quiet: true });
    console.log(`Built ${path.relative(process.cwd(), bundle)} (${arch}, signed ${identity === "-" ? "ad hoc" : `as ${identity}`}).`);
    if (flags.has("--open") && existsSync(bundle)) run("open", [bundle]);
}

try {
    await main();
} catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
