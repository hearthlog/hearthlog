#!/usr/bin/env npx tsx
/**
 * `hearthlog artifact manifest|verify --site <id>`: the seal between a tenant's build job and its deploy job.
 *
 * The build job has no secrets. It builds the site (`build/<id>`, the generated files, the Gallery Worker) and seals
 * them in `artifact-manifest.json`: the hash of every file, the hash of the lockfile, and one hash over all of it. The
 * deploy job, which does hold secrets, restores the files, installs the same lockfile, and runs `verify` first, so
 * what it deploys is what the build job made and nothing it had to build itself.
 *
 * `compare --site <id> --against <root>` is the handover gate of a site that moves into a repository of its own: its
 * structure (routes, chunk names, precache list, gateway table, Ledger contracts, Worker config) must equal that of the
 * same site built in the other checkout (see artifact-compare.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareFingerprints, fingerprint } from "./artifact-compare.js";
import { GENERATED_DIRECTORY } from "../compose/compose-modules.js";
import { REPOSITORY_ROOT } from "../tenants/tenant-config.js";
import { siteBuildDirectory } from "../tenants/wrangler-config.js";

export const MANIFEST_FILE = "artifact-manifest.json";

export interface ArtifactManifest {
    schemaVersion: 1;
    site: string;
    /** Hash of the lockfile the build installed. */
    lockfile: string;
    /** Hash of every file, by path relative to the host root. */
    files: Record<string, string>;
    /** One hash over the lockfile and all the file hashes. */
    sha256: string;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function filesUnder(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules" && entry.name !== ".DS_Store")
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => (entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]));
}

function digest(lockfile: string, files: Record<string, string>): string {
    return sha256([lockfile, ...Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => `${path}\0${hash}`)].join("\n"));
}

/** The paths a deploy needs: the site's build output and every generated file. */
export function artifactPaths(siteId: string, root: string = REPOSITORY_ROOT): string[] {
    return [join(root, siteBuildDirectory(siteId)), join(root, relative(REPOSITORY_ROOT, GENERATED_DIRECTORY))];
}

export function buildManifest(siteId: string, root: string = REPOSITORY_ROOT, paths: string[] = artifactPaths(siteId, root)): ArtifactManifest {
    const lockfile = sha256(readFileSync(join(root, "pnpm-lock.yaml")));
    const files: Record<string, string> = {};
    for (const file of paths.flatMap(filesUnder)) files[relative(root, file).split(sep).join("/")] = sha256(readFileSync(file));
    return { schemaVersion: 1, site: siteId, lockfile, files, sha256: digest(lockfile, files) };
}

/** Why the files on disk are not the ones the manifest sealed; empty when they are. */
export function manifestProblems(manifest: ArtifactManifest, root: string = REPOSITORY_ROOT, paths: string[] = artifactPaths(manifest.site, root)): string[] {
    const problems: string[] = [];
    const current = buildManifest(manifest.site, root, paths);
    if (manifest.schemaVersion !== 1) problems.push(`the manifest has schema version ${String(manifest.schemaVersion)}, not 1`);
    if (current.lockfile !== manifest.lockfile) problems.push("pnpm-lock.yaml is not the lockfile the build installed");
    for (const path of Object.keys(manifest.files)) {
        if (!(path in current.files)) problems.push(`${path} is missing`);
        else if (current.files[path] !== manifest.files[path]) problems.push(`${path} changed since the build`);
    }
    for (const path of Object.keys(current.files)) if (!(path in manifest.files)) problems.push(`${path} was not part of the build`);
    if (digest(manifest.lockfile, manifest.files) !== manifest.sha256) problems.push("the manifest's own hash does not match its entries");
    return problems;
}

async function main(argv: string[]): Promise<void> {
    const [command, ...rest] = argv;
    const siteIndex = rest.indexOf("--site");
    const siteId = siteIndex === -1 ? undefined : rest[siteIndex + 1];
    if ((command !== "manifest" && command !== "verify" && command !== "compare") || !siteId) {
        console.error("Usage: hearthlog artifact manifest --site <id>\n       hearthlog artifact verify   --site <id>\n       hearthlog artifact compare  --site <id> --against <built host root>");
        process.exit(1);
    }
    if (command === "compare") {
        const againstIndex = rest.indexOf("--against");
        const other = againstIndex === -1 ? undefined : rest[againstIndex + 1];
        if (!other) throw new Error("Usage: hearthlog artifact compare --site <id> --against <built host root>");
        const here = await fingerprint(REPOSITORY_ROOT, siteId);
        const there = await fingerprint(resolve(other), siteId);
        const { problems, identical } = compareFingerprints(siteId, there, here, ["other", "this"]);
        console.log(`${siteId}: ${here.routes.length} routes, ${here.chunks.length} chunks, ${here.precache.length} precache entries; ${identical} of ${there.contents.length} files under _app are byte-identical (informational)`);
        if (problems.length > 0) {
            console.error(`This build does not match the other one:\n${problems.join("\n")}`);
            process.exit(1);
        }
        console.log(`The build of ${siteId} here ships what the build in ${resolve(other)} ships.`);
        return;
    }
    const path = join(REPOSITORY_ROOT, MANIFEST_FILE);
    if (command === "manifest") {
        const manifest = buildManifest(siteId);
        if (Object.keys(manifest.files).length === 0) throw new Error(`There is nothing to seal for ${siteId}: build it first`);
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`Sealed ${Object.keys(manifest.files).length} files of ${siteId}: ${manifest.sha256}`);
        return;
    }
    const manifest = JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
    if (manifest.site !== siteId) throw new Error(`The manifest is for ${manifest.site}, not ${siteId}`);
    const problems = manifestProblems(manifest);
    if (problems.length > 0) {
        console.error(`The artifact does not match its manifest:\n${problems.slice(0, 20).map((problem) => `  - ${problem}`).join("\n")}`);
        process.exit(1);
    }
    console.log(`The artifact of ${siteId} matches its manifest: ${manifest.sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
