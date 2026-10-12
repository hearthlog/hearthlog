import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The site a build works on: `VITE_STOR_TENANT` when it is set, otherwise the host's only site (a repository
 * made by `hearthlog init` or `hearthlog export` holds one), otherwise "st", the development site of the platform.
 */
export function activeSiteId(root: string = hostRoot()): string {
    const named = process.env.VITE_STOR_TENANT?.trim();
    if (named) return named;
    const sites = new Set<string>();
    const tenants = join(root, "tenants");
    if (existsSync(tenants)) {
        for (const entry of readdirSync(tenants, { withFileTypes: true })) {
            if (entry.isDirectory() && existsSync(join(tenants, entry.name, "tenant.json"))) sites.add(entry.name);
        }
    }
    try {
        const listed = (JSON.parse(readFileSync(join(root, "tenants.json"), "utf8")) as { sites?: Array<{ id?: unknown }> }).sites ?? [];
        for (const site of listed) if (typeof site.id === "string") sites.add(site.id);
    } catch {
        // No tenants.json, or one the tenant configuration check reports: the directories decide.
    }
    return sites.size === 1 ? [...sites][0]! : "st";
}

/**
 * The repository a command works on: the nearest directory, from the working directory upward, that
 * holds `tenants.json`. Commands act on the host they are run in, not on where this package is installed.
 */
export function hostRoot(start: string = process.cwd()): string {
    let directory = resolve(start);
    for (;;) {
        if (existsSync(join(directory, "tenants.json")) || existsSync(join(directory, "tenants"))) return directory;
        const parent = dirname(directory);
        if (parent === directory) return resolve(start);
        directory = parent;
    }
}
