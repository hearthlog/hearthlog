#!/usr/bin/env npx tsx
/**
 * Splits a tenant of the shared stack onto its own Ledger and buckets, keeping
 * every identity (docs/tenant-split-runbook.md). Each step changes nothing it
 * cannot repeat, and none of them switches traffic except `cutover`, which you
 * run yourself once `verify` passes.
 *
 *   pnpm tenant:split -- declare  --site bravo      # write tenants/bravo/deployment.json (keep it local; see the runbook)
 *   pnpm tenant:split -- fence    --site bravo --mode tenant_migrating|moved|off
 *   pnpm tenant:split -- transfer --site bravo      # history: source Ledger -> own Ledger
 *   pnpm tenant:split -- files    --site bravo      # objects: shared buckets -> own buckets
 *   pnpm tenant:split -- verify   --site bravo      # checksums, file report, denied access
 *   pnpm tenant:split -- cutover  --site bravo      # verify, mint the gateway token, deploy the gateway (--skip-access: leave Access alone)
 *
 * The site must already have `tenants/<id>/deployment.json` and its stack must
 * be provisioned empty (`pnpm hearthlog apply --site <id> --yes --stop-before ledger-app`: the import needs a
 * Ledger with no application, and creates the application itself under its original id).
 *
 * `verify --skip-files` skips the file copy check and is accepted only against a Ledger on localhost (a rehearsal).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { identityMapping, validateMapping } from "../tenants/tenant-copy-plan.js";
import { moveApplication, sameChecksums, type AdminCall, type LogChecksum } from "@hearthlog/tooling";

import { buildCopyWorkerConfig, copyFilesThrough, workerClient, type FilesReport } from "./copy-tenant.js";
import { dedicatedLedgerBaseUrl, resolveDedicatedAdminToken } from "./dedicated-ledger.js";
import { runWrangler } from "./deploy-runner.js";
import { resolveLedgerAdminToken, resolveLedgerBaseUrl } from "./ledger-credential.js";
import {
    gallerySweeperId,
    infrastructureFor,
    loadTenantConfig,
    REPOSITORY_ROOT,
    siteById,
    type InfrastructureDefinition,
    type ResolvedSite,
} from "../tenants/tenant-config.js";
import { WRANGLER_BASE } from "../tenants/wrangler-base.js";

const COPY_WORKER_CONFIG = "wrangler.tenant-move.jsonc";

export function movesDirectory(siteId: string): string {
    return join(REPOSITORY_ROOT, ".wrangler", "tenant-moves", siteId);
}

export function adminCaller(baseUrl: string, token: string): AdminCall {
    return (method, path, body) =>
        fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
}

interface Stacks {
    site: ResolvedSite;
    shared: InfrastructureDefinition;
    source: AdminCall;
    target: () => Promise<AdminCall>;
    sourceAppId: string;
}

async function stacks(siteId: string): Promise<Stacks> {
    const { infrastructure, sites } = await loadTenantConfig();
    const site = siteById(sites, siteId);
    if (!site.deployment) throw new Error(`${siteId} has no tenants/${siteId}/deployment.json: add it, then provision the stack with "pnpm hearthlog apply --site ${siteId} --yes --stop-before ledger-app"`);
    const sourceToken = await resolveLedgerAdminToken();
    if (!sourceToken) throw new Error("No administrator token for the shared Ledger (LEDGER_ADMIN_TOKEN)");
    const source = adminCaller(resolveLedgerBaseUrl(process.env.LEDGER_BASE_URL, infrastructure.ledgerWorker, infrastructure.workersDevDomain), sourceToken);
    const response = await source("GET", "/admin/v1/apps");
    if (!response.ok) throw new Error(`Listing the shared Ledger's applications failed with ${response.status}`);
    const apps = ((await response.json()) as { apps: Array<{ id: string; name: string; revokedAt: string | null }> }).apps;
    const app = apps.find((candidate) => candidate.name === site.ledgerAppName && candidate.revokedAt === null);
    if (!app) throw new Error(`The shared Ledger has no active application "${site.ledgerAppName}"`);
    return {
        site,
        shared: infrastructure,
        source,
        sourceAppId: app.id,
        target: async () => {
            const token = await resolveDedicatedAdminToken(site.id);
            if (!token) throw new Error(`No administrator token for the ${site.id} Ledger: provision it first`);
            return adminCaller(process.env[`LEDGER_BASE_URL_${site.id.toUpperCase().replace(/-/g, "_")}`]?.trim() || dedicatedLedgerBaseUrl(site, infrastructure), token);
        },
    };
}

async function newRun(siteId: string): Promise<string> {
    const directory = join(movesDirectory(siteId), new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(directory, { recursive: true });
    return directory;
}

/** The latest run directory holding `file`, so `files` and `verify` follow `transfer`. */
async function latest(siteId: string, file: string): Promise<string | null> {
    const runs = (await readdir(movesDirectory(siteId)).catch(() => [] as string[])).sort().reverse();
    for (const run of runs) {
        try {
            await readFile(join(movesDirectory(siteId), run, file));
            return join(movesDirectory(siteId), run);
        } catch {
            // Try the next older run.
        }
    }
    return null;
}

async function fence(siteId: string, mode: string): Promise<void> {
    if (!["tenant_migrating", "moved", "off"].includes(mode)) throw new Error('--mode must be tenant_migrating, moved, or off');
    const { site, source, sourceAppId } = await stacks(siteId);
    const body = mode === "moved" ? { mode, destination: new URL(site.hostname).origin } : { mode };
    const response = await source("PUT", `/admin/v1/apps/${sourceAppId}/fence`, body);
    if (!response.ok) throw new Error(`Setting the fence failed with ${response.status}: ${await response.text()}`);
    console.log(`Fence on ${site.ledgerAppName} (${sourceAppId}): ${mode}`);
}

async function transfer(siteId: string, allowUnfenced: boolean): Promise<void> {
    const { site, source, target, sourceAppId } = await stacks(siteId);
    const run = await newRun(siteId);
    const report = await moveApplication({ appId: sourceAppId, source, target: await target(), allowUnfenced, log: (message) => console.log(message) });
    await writeFile(join(run, "transfer.json"), `${JSON.stringify({ site: site.id, ...report }, null, 2)}\n`, { mode: 0o600 });
    console.log(`\nMoved ${report.logs} log(s), ${report.events} event(s), ${report.requests} idempotency record(s). Report: ${relative(REPOSITORY_ROOT, run)}/transfer.json`);
}

async function files(siteId: string): Promise<void> {
    const { site, shared, sourceAppId } = await stacks(siteId);
    const run = (await latest(siteId, "transfer.json")) ?? (await newRun(siteId));
    const mapping = identityMapping(sourceAppId);
    validateMapping(mapping);
    const name = `${site.id}-tenant-move`;
    const own = infrastructureFor(site, shared);
    const config = buildCopyWorkerConfig(name, shared, own, WRANGLER_BASE.compatibility_date);
    await writeFile(join(REPOSITORY_ROOT, COPY_WORKER_CONFIG), `${JSON.stringify({ ...config, name }, null, 2)}\n`, "utf8");
    const token = randomBytes(32).toString("base64url");
    console.log(`Deploying the short-lived copy Worker ${name}...`);
    await runWrangler(COPY_WORKER_CONFIG, null, ["deploy"]);
    try {
        await runWrangler(COPY_WORKER_CONFIG, null, ["secret", "bulk"], { input: `${JSON.stringify({ COPY_TOKEN: token })}\n` });
        const report = await copyFilesThrough(workerClient(`https://${name}.${own.workersDevDomain}`, token), mapping);
        await writeFile(join(run, "files-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        const total = report.jobs.reduce((sum, job) => sum + job.checked, 0);
        console.log(`\nCopied and compared ${total} object(s), ${report.publications} publication(s). Report: ${relative(REPOSITORY_ROOT, run)}/files-report.json`);
    } finally {
        console.log(`Deleting the copy Worker ${name}...`);
        await runWrangler(COPY_WORKER_CONFIG, null, ["delete", "--force"]);
    }
}

export interface VerifyInput {
    source: LogChecksum[];
    target: LogChecksum[];
    files: FilesReport | null;
    /** A rehearsal against a local Ledger has no buckets to copy; a real move never skips the file check. */
    skipFiles?: boolean;
    /** What the destination answered to a request with a credential it did not issue. */
    foreignCredentialStatus: number;
}

/** Everything `verify` checks, as a list of what is wrong. */
export function verificationProblems(input: VerifyInput): string[] {
    const problems = sameChecksums(input.source, input.target);
    if (!input.files && !input.skipFiles) problems.push("no files report: run the files step");
    if (input.foreignCredentialStatus !== 401 && input.foreignCredentialStatus !== 403) {
        problems.push(`the destination answered ${input.foreignCredentialStatus} to a credential it did not issue; it must refuse it`);
    }
    return problems;
}

/** `--skip-files` is only for a rehearsal: the destination must be a Ledger on this machine. */
export function maySkipFiles(destinationUrl: string): boolean {
    const host = new URL(destinationUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

async function verificationProblemsFor(siteId: string, skipFiles: boolean): Promise<string[]> {
    const { source, target, sourceAppId } = await stacks(siteId);
    const destination = await target();
    const read = async (call: AdminCall) => {
        const response = await call("GET", `/admin/v1/apps/${sourceAppId}/checksums`);
        if (!response.ok) throw new Error(`Reading checksums failed with ${response.status}`);
        return ((await response.json()) as { logs: LogChecksum[] }).logs;
    };
    const run = await latest(siteId, "files-report.json");
    const files = run ? (JSON.parse(await readFile(join(run, "files-report.json"), "utf8")) as FilesReport) : null;
    return verificationProblems({ source: await read(source), target: await read(destination), files, skipFiles, foreignCredentialStatus: await foreignStatus(siteId) });
}

async function verify(siteId: string, skipFiles: boolean): Promise<void> {
    if (skipFiles && !maySkipFiles(await destinationUrl(siteId))) {
        throw new Error("--skip-files is for a rehearsal against a Ledger on localhost; the destination here is not local, so the file copy must be compared");
    }
    const problems = await verificationProblemsFor(siteId, skipFiles);
    if (problems.length) {
        console.error(`Verification failed:\n  - ${problems.join("\n  - ")}`);
        process.exit(1);
    }
    console.log(skipFiles
        ? "Verified (files skipped, rehearsal): event checksums match on every log, and the destination refuses a credential it did not issue."
        : "Verified: event checksums match on every log, the file copy was compared, and the destination refuses a credential it did not issue.");
}

/** The destination signs its own tokens: a credential it did not issue must be refused. */
async function destinationUrl(siteId: string): Promise<string> {
    const { infrastructure, sites } = await loadTenantConfig();
    const site = siteById(sites, siteId);
    return (process.env[`LEDGER_BASE_URL_${site.id.toUpperCase().replace(/-/g, "_")}`]?.trim() || dedicatedLedgerBaseUrl(site, infrastructure)).replace(/\/$/, "");
}

async function foreignStatus(siteId: string): Promise<number> {
    const base = await destinationUrl(siteId);
    const response = await fetch(`${base}/session`, { headers: { Authorization: `Bearer ${randomBytes(48).toString("base64url")}` } });
    return response.status;
}

const BIN = fileURLToPath(new URL("../../bin/hearthlog.mjs", import.meta.url));

/** Run a `hearthlog` command of this package for the site, and wait for it. */
function hearthlog(args: string[]): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [BIN, ...args], { cwd: REPOSITORY_ROOT, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolveRun() : reject(new Error(`hearthlog ${args.join(" ")} exited with ${String(code)}`))));
    });
}

/**
 * Write `tenants/<id>/deployment.json` for a site that is about to leave the shared stack, pinned to the shared stack's
 * account so the move stays in it. This changes the site's configuration: it no longer deploys from the shared
 * pipeline, and the shared feed Worker loses its binding. Keep the file out of anything that is pushed until the
 * cutover is done (docs/tenant-split-runbook.md).
 */
async function declare(siteId: string, accountOverride: string | undefined): Promise<void> {
    const { infrastructure, sites, stacks } = await loadTenantConfig();
    const site = siteById(sites, siteId);
    if (site.deployment) throw new Error(`${siteId} already has tenants/${siteId}/deployment.json`);
    const accountId = accountOverride ?? infrastructure.accountId;
    if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) {
        throw new Error("Name the account: set infrastructure.accountId in tenants.json (the account of the shared stack) or pass --account-id");
    }
    const path = join(REPOSITORY_ROOT, "tenants", siteId, "deployment.json");
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, resourcePrefix: `${siteId}-prod`, ledger: "dedicated", accountId }, null, 2)}\n`, { flag: "wx" });
    console.log(`Wrote ${relative(REPOSITORY_ROOT, path)} (resource prefix ${siteId}-prod, account pinned).`);
    console.log("Keep it local: pushing it would redeploy the shared feed Worker without this site's binding while its frontend still runs on the shared stack.");
    if (gallerySweeperId(stacks, infrastructure) === siteId) {
        console.log(`${siteId} sweeps the shared public Gallery bucket: set infrastructure.gallerySweeper in tenants.json to a site that stays on the shared stack.`);
    }
}

/**
 * The switch: check the move again, mint the gateway's token on the new Ledger, and deploy the gateway bound to it. The
 * token goes to the live gateway first, which still talks to the old Ledger until the deploy lands, so the two run
 * back to back. It stops before marking the old application moved (`fence --mode moved`).
 */
async function cutover(siteId: string, skipAccess: boolean): Promise<void> {
    const problems = await verificationProblemsFor(siteId, false);
    if (problems.length) {
        console.error(`Not cutting over; verification failed:\n  - ${problems.join("\n  - ")}`);
        process.exit(1);
    }
    console.log("Verified. Minting the gateway token on the new Ledger, then deploying the gateway.");
    // The Access application is the same one (same origin), so a run without CLOUDFLARE_API_TOKEN may leave it alone;
    // the gateway keeps the audience secret it already holds.
    await hearthlog(["ensure", "--site", siteId, "--rotate-token", ...(skipAccess ? ["--skip-access"] : [])]);
    await hearthlog(["deploy", "--site", siteId]);
    console.log(`\nThe ${siteId} gateway now talks to its own Ledger. Next: pnpm tenant:split -- fence --site ${siteId} --mode moved`);
}

async function main(argv: string[]): Promise<void> {
    const args = argv.filter((argument) => argument !== "--");
    const [command, ...rest] = args;
    const value = (name: string) => {
        const index = rest.indexOf(name);
        return index === -1 ? undefined : rest[index + 1]?.trim();
    };
    const siteId = value("--site");
    if (!command || !siteId) {
        console.error("Usage: pnpm tenant:split -- <declare|fence|transfer|files|verify|cutover> --site <id> [--mode tenant_migrating|moved|off] [--allow-unfenced] [--skip-files] [--skip-access] [--account-id <id>]");
        process.exit(1);
    }
    if (command === "declare") await declare(siteId, value("--account-id"));
    else if (command === "fence") await fence(siteId, value("--mode") ?? "");
    else if (command === "transfer") await transfer(siteId, rest.includes("--allow-unfenced"));
    else if (command === "files") await files(siteId);
    else if (command === "verify") await verify(siteId, rest.includes("--skip-files"));
    else if (command === "cutover") await cutover(siteId, rest.includes("--skip-access"));
    else throw new Error(`Unknown command "${command}"`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
