#!/usr/bin/env npx tsx
/**
 * Copy one tenant into a new tenant on its own stack, with new identities.
 *
 * The source is only read. Both tenants keep working and diverge afterwards;
 * nothing is merged back. See docs/tenant-copy.md for the full runbook.
 *
 *   events  Export the source app through the Ledger administrator API (the
 *           source app's own token is neither needed nor rotated), restore it
 *           into the target Ledger as a new app named after the target site,
 *           with new log IDs, and verify. Event IDs, timestamps, authors,
 *           action grouping, fork lineage, and hidden logs are kept. Writes
 *           `mapping.json` (IDs only, no tokens).
 *   files   Deploy a short-lived copy Worker bound to the source and target
 *           buckets, copy invoice files, Gallery files, and the source app's
 *           Gallery publications with app and log IDs rewritten from the
 *           mapping, compare every object, then delete the Worker.
 *
 * Usage:
 *   pnpm tenant:copy -- events --from alpha --to jst [--allow-skipped-forks]
 *   pnpm tenant:copy -- files --from alpha --to jst --run <directory>
 *
 * Environment: the administrator tokens of both Ledgers (LEDGER_ADMIN_TOKEN or
 * .wrangler/tenants/.admin-token for the shared Ledger, LEDGER_ADMIN_TOKEN_<SITE>
 * or .wrangler/tenants/<id>/.admin-token for a site's own Ledger), optional
 * LEDGER_BASE_URL / LEDGER_BASE_URL_<SITE> overrides, and a wrangler login for
 * `files`.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dedicatedLedgerBaseUrl, resolveDedicatedAdminToken } from "./dedicated-ledger.js";
import { runWrangler } from "./deploy-runner.js";
import { resolveLedgerAdminToken, resolveLedgerBaseUrl } from "./ledger-credential.js";
import {
    infrastructureFor,
    loadTenantConfig,
    REPOSITORY_ROOT,
    siteById,
    type InfrastructureDefinition,
    type ResolvedSite,
} from "../tenants/tenant-config.js";
import { planFileCopies, validateMapping, type CopyJob, type TenantCopyMapping } from "../tenants/tenant-copy-plan.js";
import { WRANGLER_BASE } from "../tenants/wrangler-base.js";
import { ledgerScript } from "./ledger-scripts.js";

const COPY_ROOT = join(REPOSITORY_ROOT, ".wrangler", "tenant-copies");
const COPY_WORKER_CONFIG = "wrangler.tenant-copy.jsonc";

interface Options {
    command: "events" | "files" | "help";
    from: string;
    to: string;
    run?: string;
    allowSkippedForks: boolean;
}

interface LedgerAccess {
    baseUrl: string;
    adminToken: string;
}

interface AppSummary {
    id: string;
    name: string;
    revokedAt: string | null;
}

interface LogSummary {
    id: string;
    headVersion: number;
    sourceLogId: string | null;
    sourceVersion: number | null;
    hiddenAt: string | null;
    status: string;
}

interface OwnedPage { owned: string[]; cursor: string | null }
interface CopyPage { copied: number; skipped: number; bytes: number; cursor: string | null }
interface ComparePage { checked: number; problems: string[]; cursor: string | null }

export interface CopyRecord {
    source: { site: string; appId: string };
    target: { site: string; appId: string };
    copiedAt: string;
    manifestSha256: string;
    logs: Array<{ sourceLogId: string; targetLogId: string; headVersion: number; hidden: boolean }>;
    skippedLogIds: string[];
}

export function parseOptions(argv: string[]): Options {
    const args = argv.filter((argument) => argument !== "--");
    const command = args[0];
    const options: Options = {
        command: command === "events" || command === "files" ? command : "help",
        from: "",
        to: "",
        allowSkippedForks: false,
    };
    for (let index = 1; index < args.length; index += 1) {
        const argument = args[index];
        const value = () => {
            const next = args[index + 1]?.trim();
            if (!next) throw new Error(`${argument} requires a value`);
            index += 1;
            return next;
        };
        switch (argument) {
            case "--from": options.from = value(); break;
            case "--to": options.to = value(); break;
            case "--run": options.run = value(); break;
            case "--allow-skipped-forks": options.allowSkippedForks = true; break;
            case "--help": case "-h": options.command = "help"; break;
            default: throw new Error(`Unknown option: ${argument}`);
        }
    }
    if (options.command !== "help" && (!options.from || !options.to)) throw new Error("--from and --to are required");
    if (options.command === "files" && !options.run) throw new Error("files needs --run <directory> from the events step");
    return options;
}

async function ledgerAccess(site: ResolvedSite, shared: InfrastructureDefinition): Promise<LedgerAccess> {
    if (site.deployment) {
        const variable = site.id.toUpperCase().replace(/-/g, "_");
        const adminToken = await resolveDedicatedAdminToken(site.id);
        if (!adminToken) throw new Error(`No administrator token for the ${site.id} Ledger`);
        return {
            baseUrl: process.env[`LEDGER_BASE_URL_${variable}`]?.trim().replace(/\/$/, "") || dedicatedLedgerBaseUrl(site, shared),
            adminToken,
        };
    }
    const adminToken = await resolveLedgerAdminToken();
    if (!adminToken) throw new Error("No administrator token for the shared Ledger (LEDGER_ADMIN_TOKEN)");
    return { baseUrl: resolveLedgerBaseUrl(process.env.LEDGER_BASE_URL, shared.ledgerWorker, shared.workersDevDomain), adminToken };
}

async function adminApi<T>(ledger: LedgerAccess, route: string): Promise<T> {
    const response = await fetch(`${ledger.baseUrl}${route}`, { headers: { Authorization: `Bearer ${ledger.adminToken}` } });
    if (!response.ok) throw new Error(`GET ${route} failed with ${response.status}`);
    return await response.json() as T;
}

async function activeApp(ledger: LedgerAccess, name: string): Promise<AppSummary | null> {
    const { apps } = await adminApi<{ apps: AppSummary[] }>(ledger, "/admin/v1/apps");
    const matches = apps.filter((app) => app.name === name && app.revokedAt === null);
    if (matches.length > 1) throw new Error(`Ledger has ${matches.length} active apps named "${name}"`);
    return matches[0] ?? null;
}

/** Run the logical backup script; stdout is its JSON result, never shown. */
function logicalBackup(args: string[], ledger: LedgerAccess): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
        const backup = ledgerScript("logical-backup", args);
        const child = spawn(backup.command, backup.args, {
            cwd: REPOSITORY_ROOT,
            env: { ...process.env, LEDGER_BASE_URL: ledger.baseUrl, LEDGER_ADMIN_TOKEN: ledger.adminToken },
            stdio: ["ignore", "pipe", "inherit"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) return reject(new Error(`logical backup ${args[0]} failed with exit code ${code}`));
            try {
                resolvePromise(JSON.parse(output));
            } catch {
                reject(new Error(`logical backup ${args[0]} printed no JSON result`));
            }
        });
    });
}

async function copyEvents(options: Options): Promise<void> {
    const { infrastructure, sites } = await loadTenantConfig();
    const source = siteById(sites, options.from);
    const target = siteById(sites, options.to);
    if (!target.deployment) throw new Error(`Target ${target.id} must run on its own stack (tenants/${target.id}/deployment.json)`);
    const sourceLedger = await ledgerAccess(source, infrastructure);
    const targetLedger = await ledgerAccess(target, infrastructure);
    if (sourceLedger.baseUrl === targetLedger.baseUrl) throw new Error("Source and target use the same Ledger");

    const sourceApp = await activeApp(sourceLedger, source.ledgerAppName);
    if (!sourceApp) throw new Error(`The source Ledger has no active app named "${source.ledgerAppName}"`);
    const existing = await activeApp(targetLedger, target.ledgerAppName);
    if (existing) {
        throw new Error(
            `The ${target.id} Ledger already has an app named "${target.ledgerAppName}" (${existing.id}). ` +
                "A copy only goes into a new app; to redo it, revoke that app first (see docs/tenant-copy.md).",
        );
    }

    const run = join(COPY_ROOT, `${target.id}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`);
    await mkdir(run, { recursive: true, mode: 0o700 });
    console.log(`Exporting ${source.id} (${sourceApp.id}) through the administrator API...`);
    const exported = await logicalBackup(["export", "--app", sourceApp.id, "--output", join(run, "export")], sourceLedger) as {
        manifestSha256: string;
        skippedLogIds: string[];
    };
    if (exported.skippedLogIds.length > 0 && !options.allowSkippedForks) {
        throw new Error(
            `Forks still being prepared were skipped: ${exported.skippedLogIds.join(", ")}. ` +
                "Let them finish and run again, or pass --allow-skipped-forks to copy without them.",
        );
    }

    console.log(`Restoring into the ${target.id} Ledger as "${target.ledgerAppName}"...`);
    const restored = await logicalBackup(["restore", "--input", join(run, "export"), "--name", target.ledgerAppName], targetLedger) as {
        app: { id: string };
        manifestSha256: string;
        logs: Array<{ sourceLogId: string; targetLogId: string }>;
    };
    if (restored.manifestSha256 !== exported.manifestSha256) throw new Error("Restore read a different export");

    const record = await verifyEvents(sourceLedger, targetLedger, sourceApp.id, restored.app.id, restored.logs);
    const result: CopyRecord = {
        source: { site: source.id, appId: sourceApp.id },
        target: { site: target.id, appId: restored.app.id },
        copiedAt: new Date().toISOString(),
        manifestSha256: exported.manifestSha256,
        logs: record,
        skippedLogIds: exported.skippedLogIds,
    };
    await writeFile(join(run, "mapping.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(
        `\nCopied ${record.length} log(s) into app ${restored.app.id}. Mapping: ${relative(REPOSITORY_ROOT, run)}/mapping.json\n` +
            `Next: pnpm tenant:copy -- files --from ${source.id} --to ${target.id} --run ${relative(REPOSITORY_ROOT, run)}\n` +
            `Then give the ${target.id} gateway a token: pnpm ensure:tenant -- --site ${target.id} --rotate-token`,
    );
}

/** Heads, lineage, and hidden state match across the mapping; restore already compared every event page. */
async function verifyEvents(
    sourceLedger: LedgerAccess,
    targetLedger: LedgerAccess,
    sourceAppId: string,
    targetAppId: string,
    pairs: ReadonlyArray<{ sourceLogId: string; targetLogId: string }>,
): Promise<CopyRecord["logs"]> {
    const sourceLogs = new Map((await adminApi<{ logs: LogSummary[] }>(sourceLedger, `/admin/v1/apps/${sourceAppId}/logs`)).logs.map((log) => [log.id, log]));
    const targetLogs = new Map((await adminApi<{ logs: LogSummary[] }>(targetLedger, `/admin/v1/apps/${targetAppId}/logs`)).logs.map((log) => [log.id, log]));
    const mapped = new Map(pairs.map((pair) => [pair.sourceLogId, pair.targetLogId]));
    if (targetLogs.size !== pairs.length) throw new Error(`Target app has ${targetLogs.size} logs, expected ${pairs.length}`);
    return pairs.map(({ sourceLogId, targetLogId }) => {
        const from = sourceLogs.get(sourceLogId);
        const to = targetLogs.get(targetLogId);
        if (!from || !to) throw new Error(`Log ${sourceLogId} is missing after the copy`);
        // The source may have moved on since the export; the copy holds the exported head.
        if (to.headVersion > from.headVersion) throw new Error(`Log ${targetLogId} is ahead of its source`);
        const expectedParent = from.sourceLogId ? mapped.get(from.sourceLogId) ?? null : null;
        if ((to.sourceLogId ?? null) !== expectedParent || (to.sourceVersion ?? null) !== (from.sourceVersion ?? null)) {
            throw new Error(`Fork lineage of ${targetLogId} does not match ${sourceLogId}`);
        }
        if (Boolean(to.hiddenAt) !== Boolean(from.hiddenAt)) throw new Error(`Hidden state of ${targetLogId} does not match`);
        return { sourceLogId, targetLogId, headVersion: to.headVersion, hidden: Boolean(to.hiddenAt) };
    });
}

export function buildCopyWorkerConfig(
    name: string,
    source: InfrastructureDefinition,
    target: InfrastructureDefinition,
    compatibilityDate: string,
): Record<string, unknown> {
    return {
        name,
        main: "tenant-copy/index.ts",
        compatibility_date: compatibilityDate,
        workers_dev: true,
        preview_urls: false,
        r2_buckets: [
            { binding: "SOURCE_INVOICE_PDFS", bucket_name: source.invoicePdfsBucket },
            { binding: "TARGET_INVOICE_PDFS", bucket_name: target.invoicePdfsBucket },
            { binding: "SOURCE_GALLERY_FILES", bucket_name: source.galleryFilesBucket },
            { binding: "TARGET_GALLERY_FILES", bucket_name: target.galleryFilesBucket },
            { binding: "SOURCE_GALLERY_PUBLIC", bucket_name: source.galleryPublicBucket },
            { binding: "TARGET_GALLERY_PUBLIC", bucket_name: target.galleryPublicBucket },
        ],
    };
}

async function copyFiles(options: Options): Promise<void> {
    const { infrastructure, sites } = await loadTenantConfig();
    const source = siteById(sites, options.from);
    const target = siteById(sites, options.to);
    const run = resolve(REPOSITORY_ROOT, options.run!);
    const record = JSON.parse(await readFile(join(run, "mapping.json"), "utf8")) as CopyRecord;
    if (record.source.site !== source.id || record.target.site !== target.id) throw new Error("The mapping belongs to another copy");
    const mapping: TenantCopyMapping = {
        sourceAppId: record.source.appId,
        targetAppId: record.target.appId,
        logs: Object.fromEntries(record.logs.map((log) => [log.sourceLogId, log.targetLogId])),
    };
    validateMapping(mapping);

    const name = `${target.id}-tenant-copy`;
    const config = buildCopyWorkerConfig(name, infrastructureFor(source, infrastructure), infrastructureFor(target, infrastructure), WRANGLER_BASE.compatibility_date);
    await writeFile(join(REPOSITORY_ROOT, COPY_WORKER_CONFIG), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const token = randomBytes(32).toString("base64url");
    const url = `https://${name}.${infrastructureFor(target, infrastructure).workersDevDomain}`;

    console.log(`Deploying the short-lived copy Worker ${name}...`);
    await runWrangler(COPY_WORKER_CONFIG, null, ["deploy"]);
    try {
        await runWrangler(COPY_WORKER_CONFIG, null, ["secret", "bulk"], { input: `${JSON.stringify({ COPY_TOKEN: token })}\n` });
        const report = await copyFilesThrough(workerClient(url, token), mapping);
        await writeFile(join(run, "files-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        const total = report.jobs.reduce((sum, job) => sum + job.checked, 0);
        console.log(`\nCopied and compared ${total} object(s), ${report.publications} publication(s). Report: ${relative(REPOSITORY_ROOT, run)}/files-report.json`);
    } finally {
        console.log(`Deleting the copy Worker ${name}...`);
        await runWrangler(COPY_WORKER_CONFIG, null, ["delete", "--force"]);
    }
}

export type CopyCall = <T>(path: string, body: unknown) => Promise<T>;

export interface FilesReport {
    copiedAt: string;
    publications: number;
    jobs: Array<CopyJob & { copied: number; skipped: number; bytes: number; checked: number }>;
}

/** Copy, then compare, every planned prefix through a running copy Worker. */
export async function copyFilesThrough(call: CopyCall, mapping: TenantCopyMapping): Promise<FilesReport> {
    const owned: string[] = [];
    for (let cursor: string | null | undefined = undefined; cursor !== null;) {
        const page: OwnedPage = await call<OwnedPage>("/publications", { appId: mapping.sourceAppId, cursor });
        owned.push(...page.owned);
        cursor = page.cursor;
    }
    const report: FilesReport = { copiedAt: new Date().toISOString(), publications: owned.length, jobs: [] };
    for (const job of planFileCopies(mapping, owned)) {
        const body = { ...job, ...(job.rewriteOwner ? { mapping } : {}) };
        let copied = 0, skipped = 0, bytes = 0, checked = 0;
        for (let cursor: string | null | undefined = undefined; cursor !== null;) {
            const page: CopyPage = await call<CopyPage>("/copy", { ...body, cursor });
            copied += page.copied; skipped += page.skipped; bytes += page.bytes; cursor = page.cursor;
        }
        for (let cursor: string | null | undefined = undefined; cursor !== null;) {
            const page: ComparePage = await call<ComparePage>("/compare", { ...body, cursor });
            if (page.problems.length > 0) throw new Error(`Copied objects differ under ${job.toPrefix}: ${page.problems.slice(0, 5).join(", ")}`);
            checked += page.checked; cursor = page.cursor;
        }
        report.jobs.push({ ...job, copied, skipped, bytes, checked });
        if (checked > 0) console.log(`${job.pair} ${job.fromPrefix} -> ${job.toPrefix}: ${checked} object(s), ${copied} copied`);
    }
    return report;
}

export function workerClient(url: string, token: string): CopyCall {
    return async function call<T>(path: string, body: unknown): Promise<T> {
        // A new workers.dev name can take a few seconds to answer.
        for (let attempt = 0; ; attempt += 1) {
            const response = await fetch(`${url}${path}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (response.ok) return await response.json() as T;
            if (attempt < 10 && (response.status === 404 || response.status >= 520)) {
                await new Promise((wait) => setTimeout(wait, 3000));
                continue;
            }
            const detail = await response.text();
            throw new Error(`Copy Worker ${path} failed with ${response.status}: ${detail.slice(0, 300)}`);
        }
    };
}

function usage(): string {
    return `Copy a tenant into a new tenant on its own stack (new identities; the source is only read).

Usage:
  pnpm tenant:copy -- events --from <site> --to <site> [--allow-skipped-forks]
  pnpm tenant:copy -- files --from <site> --to <site> --run <directory>`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const options = parseOptions(argv);
    process.chdir(REPOSITORY_ROOT);
    if (options.command === "events") await copyEvents(options);
    else if (options.command === "files") await copyFiles(options);
    else console.log(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(`\n${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
