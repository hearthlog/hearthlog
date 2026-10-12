/**
 * The Ledger Worker of a site on its own stack (`tenants/<id>/deployment.json`).
 *
 * It runs the same Ledger code with the same `LedgerApp` / `AppRegistry`
 * classes as the shared Ledger, under its own Worker name, so its Durable
 * Object namespaces hold only that site's data. Its administrator token lives
 * in `.wrangler/tenants/<id>/.admin-token` (gitignored, mode 0600) because
 * Worker secrets cannot be read back.
 */

import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    infrastructureFor,
    REPOSITORY_ROOT,
    TenantConfigError,
    type InfrastructureDefinition,
    type ResolvedSite,
} from "../tenants/tenant-config.js";

export function dedicatedAdminTokenPath(siteId: string): string {
    return join(REPOSITORY_ROOT, ".wrangler", "tenants", siteId, ".admin-token");
}

export function requireDedicated(site: ResolvedSite): void {
    if (!site.deployment) {
        throw new TenantConfigError(
            `Site "${site.id}" uses the shared Ledger; add tenants/${site.id}/deployment.json to give it its own stack`,
        );
    }
}

export function dedicatedLedgerBaseUrl(site: ResolvedSite, shared: InfrastructureDefinition): string {
    requireDedicated(site);
    const own = infrastructureFor(site, shared);
    return `https://${own.ledgerWorker}.${own.workersDevDomain}`;
}

/** `LEDGER_ADMIN_TOKEN_<SITE>` (for example LEDGER_ADMIN_TOKEN_JST), else the local file. */
export async function resolveDedicatedAdminToken(siteId: string): Promise<string> {
    const variable = `LEDGER_ADMIN_TOKEN_${siteId.toUpperCase().replace(/-/g, "_")}`;
    const exported = process.env[variable]?.trim();
    if (exported) return exported;
    try {
        return (await readFile(dedicatedAdminTokenPath(siteId), "utf8")).trim();
    } catch {
        return "";
    }
}

export async function hasStoredAdminToken(siteId: string): Promise<boolean> {
    try {
        await access(dedicatedAdminTokenPath(siteId));
        return true;
    } catch {
        return false;
    }
}

/**
 * Fresh secrets for a new Ledger: the administrator token and the key that
 * signs app tokens. Generated here and never printed.
 */
export function newLedgerSecrets(): { ADMIN_TOKEN: string; TOKEN_SIGNING_KEY_CURRENT: string } {
    return {
        ADMIN_TOKEN: randomBytes(32).toString("base64url"),
        TOKEN_SIGNING_KEY_CURRENT: randomBytes(48).toString("base64url"),
    };
}

export async function storeAdminToken(siteId: string, token: string): Promise<void> {
    const path = dedicatedAdminTokenPath(siteId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
}
