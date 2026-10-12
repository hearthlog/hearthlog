/**
 * The lock file's content: which modules a site ships and the exact manifest each was composed from. It
 * imports nothing generated, so `hearthlog init` can write one before a site has any generated files.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODULE_API_VERSION } from "@hearthlog/contracts";

import { modulesForFeatures, type LoadedModule } from "../compose/compose-modules.js";

export interface ModuleLockEntry {
    id: string;
    package: string;
    version: string;
    /** The site's enabled features this module provides. */
    features: string[];
    /** SHA-256 of the module's `hearthlog.module.json`. */
    manifestSha256: string;
}

export interface ModuleLock {
    schemaVersion: 1;
    platform: { moduleApi: number };
    modules: ModuleLockEntry[];
}

/** The lock for the modules that provide a site's features. */
export function lockFor(modules: readonly LoadedModule[], features: readonly string[]): ModuleLock {
    const entries: ModuleLockEntry[] = modulesForFeatures(modules, features).map(({ directory, manifest }) => ({
        id: manifest.id,
        package: manifest.package,
        version: manifest.version,
        features: manifest.features.map((feature) => feature.id).filter((id) => features.includes(id)),
        manifestSha256: createHash("sha256").update(readFileSync(join(directory, "hearthlog.module.json"))).digest("hex"),
    }));
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return { schemaVersion: 1, platform: { moduleApi: MODULE_API_VERSION }, modules: entries };
}

export function renderModuleLock(lock: ModuleLock): string {
    return `${JSON.stringify(lock, null, 2)}\n`;
}
