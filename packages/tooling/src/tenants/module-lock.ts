#!/usr/bin/env npx tsx
/**
 * `tenants/<site>/modules.lock.json`: the modules a site ships, with the
 * exact manifest each was composed from. The composer builds from the
 * workspace, so the lock does not choose versions; it records them, and
 * `pnpm check:tenants` fails when a site's modules or a manifest changed
 * without the lock being regenerated. That makes a release reviewable: the
 * lock diff names every module whose contract moved.
 *
 * Usage: pnpm lock:modules [--check]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModules } from "../compose/compose-modules.js";
import { lockFor, renderModuleLock, type ModuleLock } from "./lock-file.js";

import { loadTenantConfig, TENANTS_DIRECTORY, type ResolvedSite } from "./tenant-config.js";

export { lockFor, renderModuleLock, type ModuleLock, type ModuleLockEntry } from "./lock-file.js";

export function moduleLockPath(siteId: string): string {
    return join(TENANTS_DIRECTORY, siteId, "modules.lock.json");
}

export async function buildModuleLock(site: Pick<ResolvedSite, "features">): Promise<ModuleLock> {
    return lockFor(loadModules(), site.features);
}

/** What differs between a site's lock file and the modules it would ship today. */
export async function moduleLockProblems(site: Pick<ResolvedSite, "id" | "features">): Promise<string[]> {
    const expected = renderModuleLock(await buildModuleLock(site));
    const current = await readFile(moduleLockPath(site.id), "utf8").catch(() => null);
    if (current === null) return [`tenants/${site.id}/modules.lock.json is missing; run pnpm lock:modules (hearthlog lock)`];
    // Older locks also recorded each module's version; it is not part of the contract.
    const withoutVersions = (text: string) => {
        try {
            const lock = JSON.parse(text) as { modules?: Array<Record<string, unknown>> };
            return renderModuleLock({ ...lock, modules: (lock.modules ?? []).map(({ version: _version, ...entry }) => entry) } as unknown as ModuleLock);
        } catch {
            return text;
        }
    };
    return withoutVersions(current) === expected ? [] : [`tenants/${site.id}/modules.lock.json is stale; run pnpm lock:modules (hearthlog lock)`];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { sites } = await loadTenantConfig();
    const check = process.argv.includes("--check");
    const problems: string[] = [];
    for (const site of sites) {
        if (check) {
            problems.push(...(await moduleLockProblems(site)));
            continue;
        }
        const path = moduleLockPath(site.id);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, renderModuleLock(await buildModuleLock(site)));
    }
    if (problems.length) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    console.log(check ? "Module locks are current." : `Wrote ${sites.length} module lock(s).`);
}
