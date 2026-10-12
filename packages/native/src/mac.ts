#!/usr/bin/env npx tsx
/**
 * Build the Mac app for one site with the Command Line Tools alone (no Xcode needed).
 *
 * Usage:
 *   hearthlog apple:mac <site>              build .apple-build/mac/<site>/<title>.app
 *   hearthlog apple:mac --all               every site in tenants.json
 *   hearthlog apple:mac <site> --dmg        also make the disk image in .apple-build/dist/
 *   hearthlog apple:mac <site> --universal  build for Apple silicon and Intel
 *   hearthlog apple:mac <site> --dev        debugging aids; STOR_ORIGIN can point at a dev server
 *   hearthlog apple:mac <site> --open       open the app once built
 *
 * The app is signed ad hoc unless STOR_SIGN_IDENTITY names a certificate in your keychain
 * (a self-signed one keeps camera and notification permissions across rebuilds). It is not
 * notarized, so a copy that arrives by download needs Open Anyway on first launch.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    SWIFT_DIRECTORY,
    AppleError,
    BUILD_ROOT,
    loadAppleSettings,
    loadAppleSite,
    macInfoPlist,
    renderIcons,
    run,
} from "./site.js";
import { loadTenantConfig } from "@hearthlog/tooling/tenants/tenant-config.js";

const DEPLOYMENT_TARGET = "14.0";
const ICON_SIZES = [16, 32, 128, 256, 512] as const;

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const siteId = args.find((arg) => !arg.startsWith("--"));

function swiftSources(): string[] {
    return ["Shared", "macOS"].flatMap((directory) =>
        readdirSync(path.join(SWIFT_DIRECTORY, directory))
            .filter((file) => file.endsWith(".swift"))
            .sort()
            .map((file) => path.join(SWIFT_DIRECTORY, directory, file)),
    );
}

function compile(options: { arch: string; output: string; development: boolean }) {
    const sdk = run("xcrun", ["--show-sdk-path"], { quiet: true }).trim();
    run("swiftc", [
        "-swift-version", "5",
        ...(options.development ? ["-Onone", "-g", "-DSTOR_DEV"] : ["-O", "-wmo"]),
        "-target", `${options.arch}-apple-macos${DEPLOYMENT_TARGET}`,
        "-sdk", sdk,
        "-module-name", "Stor",
        "-o", options.output,
        ...swiftSources(),
    ]);
}

async function makeIcns(site: Awaited<ReturnType<typeof loadAppleSite>>, directory: string): Promise<string> {
    const { mac } = await renderIcons(site, directory);
    const iconset = path.join(directory, "AppIcon.iconset");
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });
    for (const size of ICON_SIZES) {
        run("sips", ["-z", String(size), String(size), mac, "--out", path.join(iconset, `icon_${size}x${size}.png`)], { quiet: true });
        run("sips", ["-z", String(size * 2), String(size * 2), mac, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)], { quiet: true });
    }
    const icns = path.join(directory, "AppIcon.icns");
    run("iconutil", ["-c", "icns", iconset, "-o", icns], { quiet: true });
    return icns;
}

async function main() {
    if (!siteId && !flags.has("--all")) throw new AppleError("Usage: hearthlog apple:mac <site> | --all [--dmg] [--universal] [--dev] [--open]");
    const settings = loadAppleSettings({ requireDevice: false });
    const ids = flags.has("--all") ? (await loadTenantConfig()).sites.map((site) => site.id) : [siteId!];
    for (const id of ids) await build(id, settings);
}

async function build(id: string, settings: ReturnType<typeof loadAppleSettings>) {
    const development = flags.has("--dev");
    const site = await loadAppleSite(id, settings);
    // A development build must never share data or permissions with the real app.
    if (development) site.bundleId = `${site.bundleId}.dev`;

    const fileName = `${site.title.replace(/[^\w .-]/g, "")}${development ? "-dev" : ""}`;
    const directory = path.join(BUILD_ROOT, "mac", `${site.id}${development ? "-dev" : ""}`);
    const app = path.join(directory, `${fileName}.app`);
    rmSync(app, { recursive: true, force: true });
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });

    const executable = path.join(app, "Contents", "MacOS", fileName);
    const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
    const architectures = flags.has("--universal") ? ["arm64", "x86_64"] : [hostArch];
    const slices = architectures.map((arch) => path.join(directory, `Stor-${arch}`));
    architectures.forEach((arch, index) => compile({ arch, output: slices[index]!, development }));
    if (slices.length === 1) copyFileSync(slices[0]!, executable);
    else run("lipo", ["-create", ...slices, "-output", executable], { quiet: true });

    writeFileSync(path.join(app, "Contents", "Info.plist"), macInfoPlist(site, { executable: fileName, development, inspectable: development }));
    writeFileSync(path.join(app, "Contents", "PkgInfo"), "APPL????");
    copyFileSync(await makeIcns(site, directory), path.join(app, "Contents", "Resources", "AppIcon.icns"));

    const identity = process.env.STOR_SIGN_IDENTITY || "-";
    run("codesign", ["--force", "--sign", identity, "--identifier", site.bundleId, "--timestamp=none", app], { quiet: true });
    console.log(`Built ${path.relative(process.cwd(), app)} (${architectures.join(" + ")}, signed ${identity === "-" ? "ad hoc" : `as ${identity}`}).`);

    if (flags.has("--dmg")) {
        const dist = path.join(BUILD_ROOT, "dist");
        mkdirSync(dist, { recursive: true });
        const dmg = path.join(dist, `${fileName}-${site.version}.dmg`);
        const staging = mkdtempSync(path.join(tmpdir(), "stor-dmg-"));
        try {
            run("ditto", [app, path.join(staging, `${fileName}.app`)], { quiet: true });
            symlinkSync("/Applications", path.join(staging, "Applications"));
            rmSync(dmg, { force: true });
            run("hdiutil", ["create", "-volname", site.title, "-srcfolder", staging, "-fs", "HFS+", "-format", "UDZO", "-ov", dmg], { quiet: true });
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }
        console.log(`Made ${path.relative(process.cwd(), dmg)}.`);
        console.log("Copying it to another Mac: the first launch needs right-click > Open, or System Settings > Privacy & Security > Open Anyway.");
    }
    if (flags.has("--open") && existsSync(app)) run("open", [app]);
}

try {
    await main();
} catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
