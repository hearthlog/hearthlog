/**
 * The Ledger administrator token.
 *
 * LEDGER_ADMIN_TOKEN is the primary source; the fallback is the local copy
 * at `.wrangler/tenants/.admin-token` (gitignored, mode 0600). The fallback
 * exists because Cloudflare Worker secrets are write-only — once
 * ADMIN_TOKEN has been set with `wrangler secret put`, its value cannot be
 * read back from Cloudflare, so this file is where the token survives
 * locally.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { REPOSITORY_ROOT } from "../tenants/tenant-config.js";

export function ledgerAdminTokenPath(): string {
    return join(REPOSITORY_ROOT, ".wrangler", "tenants", ".admin-token");
}

/** A shared-stack site's Ledger credential (`.wrangler/tenants/production/<id>.json`; the folder name predates this one environment). */
export function tenantCredentialPath(siteId: string): string {
    return join(REPOSITORY_ROOT, ".wrangler", "tenants", "production", `${siteId}.json`);
}

export function legacyTenantCredentialPath(siteId: string): string {
    return join(REPOSITORY_ROOT, ".wrangler", "tenants", `${siteId}.json`);
}

export async function resolveLedgerAdminToken(): Promise<string> {
    const exported = process.env.LEDGER_ADMIN_TOKEN?.trim() ?? "";
    if (exported) return exported;
    try {
        return (await readFile(ledgerAdminTokenPath(), "utf8")).trim();
    } catch {
        return "";
    }
}

/**
 * The deployed Ledger URL, from the Ledger Worker's name. An explicit URL remains available for a local Ledger or a
 * custom domain.
 */
export function resolveLedgerBaseUrl(override: string | undefined, ledgerWorker: string, workersDevDomain: string): string {
    const configured = override?.trim();
    if (configured) return configured.replace(/\/$/, "");
    return `https://${ledgerWorker}.${workersDevDomain}`;
}
