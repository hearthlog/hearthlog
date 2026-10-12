#!/usr/bin/env npx tsx
/**
 * Tenant Backup
 *
 * Exports every site's Ledger application using the canonical
 * ledger-logical-export format (see packages/ledger/scripts/logical-backup.ts). Sites
 * must have a stored credential from `pnpm provision:tenants`.
 *
 * Environment:
 *   LEDGER_BASE_URL      e.g. http://127.0.0.1:8787 (local) or the deployed
 *                        Ledger worker URL
 *   LEDGER_ADMIN_TOKEN   administrator token, used to list all applications
 *                        so apps outside tenants.json are reported
 *   LEDGER_OUTPUT_ROOT   optional directory for the exports (default: .wrangler/backups)
 *
 * Usage: pnpm ledger:export:tenants [-- --output-suffix my-run]
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
    loadTenantConfig,
    REPOSITORY_ROOT,
} from "../tenants/tenant-config.js";
import {
    legacyTenantCredentialPath,
    tenantCredentialPath,
} from "./ledger-credential.js";
import { ledgerScript } from "./ledger-scripts.js";

const baseUrl = (process.env.LEDGER_BASE_URL ?? "").replace(/\/$/, "");
const adminToken = process.env.LEDGER_ADMIN_TOKEN ?? "";
if (!baseUrl || !adminToken) {
    console.error(
        "LEDGER_BASE_URL and LEDGER_ADMIN_TOKEN are required " +
            "(see ledger/.dev.vars.example for local values).",
    );
    process.exit(1);
}

const args = process.argv.slice(2);
const suffixIndex = args.indexOf("--output-suffix");
const suffix = suffixIndex !== -1 ? `-${args[suffixIndex + 1]}` : "";
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const outputRoot =
    process.env.LEDGER_OUTPUT_ROOT ?? join(REPOSITORY_ROOT, ".wrangler", "backups");

const { sites } = await loadTenantConfig();
const siteByAppName = new Map(sites.map((site) => [site.ledgerAppName, site]));

const response = await fetch(`${baseUrl}/admin/v1/apps`, {
    headers: { Authorization: `Bearer ${adminToken}` },
});
if (!response.ok) {
    console.error(`Listing applications failed with ${response.status}`);
    process.exit(1);
}
const { apps } = (await response.json()) as { apps: Array<{ id: string; name: string; revokedAt: string | null }> };

const activeApps = apps.filter((app) => app.revokedAt === null);
const failures: string[] = [];
const skipped: string[] = [];

await mkdir(outputRoot, { recursive: true, mode: 0o700 });

for (const app of activeApps) {
    const site = siteByAppName.get(app.name);
    if (!site) {
        skipped.push(app.name);
        console.warn(`No tenants.json site for app "${app.name}" (${app.id}); skipped.`);
        continue;
    }

    let token: string;
    try {
        const credentialFile = tenantCredentialPath(site.id);
        const fallbackCredentialFile = legacyTenantCredentialPath(site.id);
        const credential = JSON.parse(
            await import("node:fs/promises").then((fs) =>
                fs.readFile(
                    credentialFile,
                    "utf8",
                ).catch(() => fs.readFile(fallbackCredentialFile, "utf8")),
            ),
        ) as {
            appId: string;
            token: string;
        };
        if (credential.appId !== app.id) {
            skipped.push(app.name);
            console.warn(
                `Stored credential for ${site.id} points at ${credential.appId}, ` +
                    `not ${app.id}; run pnpm provision:tenants first.`,
            );
            continue;
        }
        token = credential.token;
    } catch {
        skipped.push(app.name);
        console.warn(
            `No stored credential for site ${site.id}; run pnpm provision:tenants first.`,
        );
        continue;
    }

    const output = join(outputRoot, `${app.name}${suffix}-${stamp}`);
    console.log(`\nExporting app "${app.name}" (site ${site.id}) into ${output}...`);
    const exitCode = await new Promise<number | null>((resolvePromise) => {
        const backup = ledgerScript("logical-backup", ["export", "--output", output]);
        const child = spawn(
            backup.command,
            backup.args,
            {
                cwd: REPOSITORY_ROOT,
                stdio: "inherit",
                env: {
                    ...process.env,
                    LEDGER_BASE_URL: baseUrl,
                    LEDGER_AUTH_TOKEN: token,
                },
            },
        );
        child.once("error", () => resolvePromise(1));
        child.once("exit", (code) => resolvePromise(code));
    });
    if (exitCode !== 0) failures.push(app.name);
}

console.log(
    `\nBackup finished: ${activeApps.length - skipped.length - failures.length} exported, ` +
        `${skipped.length} skipped, ${failures.length} failed.`,
);
if (skipped.length > 0) console.log(`Skipped apps: ${skipped.join(", ")}`);
if (failures.length > 0) {
    console.error(`Failed apps: ${failures.join(", ")}`);
    process.exitCode = 1;
}
