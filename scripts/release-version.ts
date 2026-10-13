/**
 * `pnpm release:version <x.y.z>` sets the version of every published package (one release train); the release workflow
 * (`.github/workflows/release.yml`, run from the Actions tab) runs it, commits, and tags. `pnpm release:version --check v<x.y.z>`
 * fails unless the tag names the version they all have (the workflow's publish job runs it).
 *
 * Internal dependencies are `workspace:*`, which `pnpm publish` writes as the exact version, so only the `version` fields change.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface PackageFile {
    path: string;
    manifest: { name: string; version: string; private?: boolean; [key: string]: unknown };
}

export function publishedPackages(root: string): PackageFile[] {
    const directory = join(root, 'packages');
    return readdirSync(directory)
        .sort()
        .map((folder) => join(directory, folder, 'package.json'))
        .flatMap((path) => {
            try {
                return [{ path, manifest: JSON.parse(readFileSync(path, 'utf8')) as PackageFile['manifest'] }];
            } catch {
                return [];
            }
        })
        .filter((file) => !file.manifest.private);
}

/** The version every published package has, or the reason they do not agree. */
export function currentVersion(files: readonly PackageFile[]): string {
    const versions = new Set(files.map((file) => file.manifest.version));
    if (versions.size !== 1) throw new Error(`The published packages have different versions: ${files.map((file) => `${file.manifest.name}@${file.manifest.version}`).join(', ')}`);
    return [...versions][0];
}

export function setVersion(root: string, version: string): string[] {
    if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
    const files = publishedPackages(root);
    for (const file of files) writeFileSync(file.path, `${JSON.stringify({ ...file.manifest, version }, null, 2)}\n`);
    return files.map((file) => file.manifest.name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = resolve(fileURLToPath(import.meta.url), '../..');
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    try {
        if (args[0] === '--check') {
            const tag = args[1] ?? '';
            const version = currentVersion(publishedPackages(root));
            if (tag !== `v${version}`) throw new Error(`The tag is "${tag}" but the packages are at ${version}`);
            console.log(`The tag matches ${version}.`);
        } else if (args[0]) {
            const names = setVersion(root, args[0]);
            console.log(`Set ${names.length} packages to ${args[0]}.`);
        } else {
            throw new Error('Usage: pnpm release:version <x.y.z> | --check v<x.y.z>');
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
