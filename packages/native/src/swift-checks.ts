#!/usr/bin/env npx tsx
/**
 * Run the shell's Swift checks (swift/Tests). They cover the rules that decide access and what
 * gets scheduled, need no Xcode, and compile in a few seconds with the Command Line Tools.
 *
 * Usage: hearthlog apple:test
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { SWIFT_DIRECTORY, run } from "./site.js";

const directory = mkdtempSync(path.join(tmpdir(), "stor-apple-test-"));
try {
    const binary = path.join(directory, "checks");
    const sdk = run("xcrun", ["--show-sdk-path"], { quiet: true }).trim();
    run("swiftc", [
        "-swift-version", "5",
        "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
        "-sdk", sdk,
        "-o", binary,
        ...["NavigationPolicy", "ShellMessage", "ReminderScheduler", "SiteConfig"].map((name) => path.join(SWIFT_DIRECTORY, "Shared", `${name}.swift`)),
        path.join(SWIFT_DIRECTORY, "Tests", "main.swift"),
    ]);
    const result = spawnSync(binary, { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
} catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    rmSync(directory, { recursive: true, force: true });
}
