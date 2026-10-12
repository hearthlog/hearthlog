#!/usr/bin/env npx tsx
/**
 * `pnpm rehearse:split [--events <n>] [--keep]`: rehearse `tenant:split` (fence, transfer, verify) against two throwaway
 * Ledgers on this machine, with no Cloudflare account and no real tenant.
 *
 * It starts two `wrangler dev` Ledgers on their own state, seeds one with a synthetic tenant (two logs, thousands of
 * events, updates, and a retried request), and runs the real `tenant:split` commands from a scratch host directory:
 *
 *   1. a transfer from an unfenced source is refused;
 *   2. the fence pauses writes (503 tenant_migrating);
 *   3. a transfer cut off mid-import fails, and a second attempt (the retry the runbook promises) succeeds;
 *   4. `verify` demands the file report, and passes with `--skip-files` against the local destination;
 *   5. the destination holds every event, refuses the source's credential, and accepts the `moved` fence.
 *
 * It does not cover the file copy (needs R2) or the gateway's handling of the fence.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = resolve(fileURLToPath(import.meta.url), "../..");
const BIN = join(REPOSITORY, "packages/tooling/bin/hearthlog.mjs");
const WRANGLER = join(REPOSITORY, "node_modules/.bin/wrangler");
const SPLIT = join(REPOSITORY, "packages/tooling/src/deploy/split-tenant.ts");
const TSX = join(REPOSITORY, "node_modules/.bin/tsx");

const argv = process.argv.slice(2);
const eventCount = Number(argv[argv.indexOf("--events") + 1] || (argv.includes("--events") ? NaN : 6000));
if (!Number.isInteger(eventCount) || eventCount < 600) throw new Error("--events must be a whole number of at least 600");

const SOURCE_PORT = 8791;
const TARGET_PORT = 8792;
const PROXY_PORT = 8793;
const ADMIN = { source: randomBytes(24).toString("base64url"), target: randomBytes(24).toString("base64url") };

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail.replace(/\n/g, "\n      ")}`}`);
    if (!ok) failures += 1;
}

// ── two local Ledgers ──────────────────────────────────────────────────────

const children: ChildProcess[] = [];

function startLedger(directory: string, name: string, port: number, adminToken: string): ChildProcess {
    mkdirSync(directory, { recursive: true });
    const config = JSON.parse(readFileSync(join(REPOSITORY, ".generated/shared/ledger/wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(directory, "wrangler.jsonc"), JSON.stringify({ ...config, name, main: join(REPOSITORY, ".generated/shared/ledger/index.ts"), account_id: undefined }, null, 2));
    writeFileSync(join(directory, ".dev.vars"), `ADMIN_TOKEN=${adminToken}\nTOKEN_SIGNING_KEY_CURRENT=${randomBytes(48).toString("base64url")}\nALLOWED_ORIGINS=\n`);
    return startWrangler(directory, port);
}

function startWrangler(directory: string, port: number): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
    for (const key of Object.keys(env)) if (key.startsWith("CLOUDFLARE_")) delete env[key];
    const child = spawn(WRANGLER, [
        "dev", "--config", join(directory, "wrangler.jsonc"), "--env-file", join(directory, ".dev.vars"),
        "--persist-to", join(directory, "state"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(port + 100),
    ], { cwd: directory, env, stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);
    return child;
}

async function ready(port: number): Promise<void> {
    for (let attempt = 0; attempt < 180; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.status === 204 || response.status === 200) return;
        } catch {
            // Not listening yet.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(`The Ledger on port ${port} did not start`);
}

// ── a proxy that can cut the connection to the destination ────────────────

/** Forwards to the destination Ledger; `cutAfter(bytes)` drops every connection once that much has been sent upstream. */
function proxy(listen: number, target: number): { server: Server; cutAfter(bytes: number): void; heal(): void } {
    const state = { limit: Infinity, sent: 0, refusing: false };
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
        if (state.refusing) return void client.destroy();
        const upstream = connect(target, "127.0.0.1");
        sockets.add(client).add(upstream);
        client.on("data", (chunk) => {
            state.sent += chunk.length;
            if (state.sent > state.limit) {
                state.refusing = true;
                for (const socket of sockets) socket.destroy();
                return;
            }
            upstream.write(chunk);
        });
        upstream.on("data", (chunk) => client.write(chunk));
        for (const socket of [client, upstream]) socket.on("close", () => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); }).on("error", () => undefined);
    });
    server.listen(listen, "127.0.0.1");
    return {
        server,
        cutAfter(bytes) { state.limit = state.sent + bytes; state.refusing = false; },
        heal() { state.limit = Infinity; state.refusing = false; },
    };
}

// ── the synthetic tenant ───────────────────────────────────────────────────

async function call(method: string, base: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
}

async function seed(base: string): Promise<{ appId: string; token: string; logs: string[]; events: number; retry: () => Promise<number> }> {
    const created = await call("POST", base, "/admin/v1/apps", ADMIN.source, { name: "rehearsal", policy: { contracts: null, dynamicEvents: true, validation: null } });
    if (created.status !== 201) throw new Error(`Creating the application failed: ${created.status} ${JSON.stringify(created.body)}`);
    const appId: string = created.body.app?.id ?? created.body.id;
    const token: string = created.body.token;
    const logs: string[] = [];
    for (const name of ["main", "scratch"]) {
        const log = await call("POST", base, "/logs", token, { name });
        if (log.status !== 201) throw new Error(`Creating a log failed: ${log.status} ${JSON.stringify(log.body)}`);
        logs.push(log.body.id ?? log.body.log?.id);
    }
    const headers = { "X-Ledger-Actor": "owner@example.com" };
    let events = 0;
    let firstEntities: string[] = [];
    let first: { requestId: string; events: unknown[]; log: string } | null = null;
    for (let start = 0; start < eventCount; start += 500) {
        const log = logs[start / 500 % 3 === 2 ? 1 : 0]!;
        const entities = Array.from({ length: Math.min(500, eventCount - start) }, () => `calendar_event:${randomUUID()}`);
        const request = {
            requestId: randomUUID(),
            events: entities.map((entityId, index) => ({
                id: randomUUID(), type: "CALENDAR_EVENT_ADDED", entityId,
                payload: { id: entityId.split(":")[1], title: `Visit ${start + index}`, eventDate: "2026-10-12", notes: "x".repeat(40) },
            })),
        };
        const response = await call("POST", base, `/logs/${log}/events`, token, request, headers);
        if (response.status !== 200 && response.status !== 201) throw new Error(`Appending failed: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
        events += entities.length;
        if (first === null) { first = { requestId: request.requestId, events: request.events, log }; firstEntities = entities; }
    }
    // Updates (entity versions) in one action batch, on the log that holds the first entities.
    const updates = firstEntities.slice(0, 50).map((entityId) => ({
        id: randomUUID(), type: "CALENDAR_EVENT_UPDATED", entityId, baseEntityVersion: 1, payload: { id: entityId.split(":")[1], notes: "updated" },
    }));
    const update = await call("POST", base, `/logs/${first!.log}/events`, token, { requestId: randomUUID(), actionId: randomUUID(), events: updates }, headers);
    if (update.status !== 200 && update.status !== 201) throw new Error(`Updating failed: ${update.status} ${JSON.stringify(update.body).slice(0, 300)}`);
    events += updates.length;
    return {
        appId, token, logs, events,
        // The same request again is answered from the idempotency record, not appended twice.
        retry: async () => (await call("POST", base, `/logs/${first!.log}/events`, token, { requestId: first!.requestId, events: first!.events }, headers)).status,
    };
}

// ── the scratch host and the split commands ───────────────────────────────

function scratchHost(root: string): string {
    const host = join(root, "host");
    const infrastructure = JSON.parse(readFileSync(join(REPOSITORY, "packages/tooling/templates/tenant/tenants.json.tmpl"), "utf8"));
    mkdirSync(join(host, "tenants/rehearsal"), { recursive: true });
    writeFileSync(join(host, "tenants.json"), JSON.stringify(infrastructure));
    writeFileSync(join(host, "tenants/rehearsal/tenant.json"), JSON.stringify({ schemaVersion: 1, id: "rehearsal", ledgerAppName: "rehearsal", authorizedEmails: ["owner@example.com"], features: [] }));
    writeFileSync(join(host, "tenants/rehearsal/deployment.json"), JSON.stringify({ schemaVersion: 1, resourcePrefix: "rehearsal-prod", ledger: "dedicated" }));
    return host;
}

function splitEnv(destinationPort: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("CLOUDFLARE_") || key.startsWith("LEDGER_")) delete env[key];
    return {
        ...env,
        LEDGER_BASE_URL: `http://127.0.0.1:${SOURCE_PORT}`,
        LEDGER_ADMIN_TOKEN: ADMIN.source,
        LEDGER_BASE_URL_REHEARSAL: `http://127.0.0.1:${destinationPort}`,
        LEDGER_ADMIN_TOKEN_REHEARSAL: ADMIN.target,
    };
}

/** Async on purpose: the proxy lives in this process and must keep forwarding while the command runs. */
function split(host: string, args: string[], destinationPort = TARGET_PORT): Promise<{ status: number; output: string }> {
    return new Promise((resolveRun) => {
        const child = spawn(TSX, [SPLIT, ...args, "--site", "rehearsal"], { cwd: host, env: splitEnv(destinationPort) });
        let output = "";
        child.stdout.on("data", (chunk) => { output += String(chunk); });
        child.stderr.on("data", (chunk) => { output += String(chunk); });
        child.on("close", (code) => resolveRun({ status: code ?? 1, output }));
    });
}

// ── the rehearsal ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "hearthlog-rehearsal-"));
    console.log(`Working in ${root}`);
    spawnSync(process.execPath, [BIN, "build", "--quiet"], { cwd: REPOSITORY, stdio: "inherit" });
    const host = scratchHost(root);
    const cut = proxy(PROXY_PORT, TARGET_PORT);
    try {
        console.log("Starting two Ledgers...");
        startLedger(join(root, "source"), "rehearsal-source", SOURCE_PORT, ADMIN.source);
        startLedger(join(root, "target"), "rehearsal-target", TARGET_PORT, ADMIN.target);
        await Promise.all([ready(SOURCE_PORT), ready(TARGET_PORT)]);

        console.log(`Seeding the source with ${eventCount} events...`);
        const source = await seed(`http://127.0.0.1:${SOURCE_PORT}`);
        const target = `http://127.0.0.1:${TARGET_PORT}`;
        check("a retried request is answered from its idempotency record", [200, 201].includes(await source.retry()));

        const unfenced = await split(host, ["transfer"]);
        check("a transfer from an unfenced source is refused", unfenced.status !== 0 && /not fenced/.test(unfenced.output), unfenced.output.slice(-400));

        const fenced = await split(host, ["fence", "--mode", "tenant_migrating"]);
        check("the fence is set", fenced.status === 0, fenced.output.slice(-400));
        const paused = await call("POST", `http://127.0.0.1:${SOURCE_PORT}`, `/logs/${source.logs[0]}/events`, source.token, { requestId: randomUUID(), events: [{ id: randomUUID(), type: "CALENDAR_EVENT_ADDED", entityId: `calendar_event:${randomUUID()}`, payload: { id: randomUUID(), title: "late" } }] });
        check("a write to the fenced source answers 503 tenant_migrating", paused.status === 503 && /tenant_migrating/.test(JSON.stringify(paused.body)), `${paused.status} ${JSON.stringify(paused.body).slice(0, 200)}`);

        // The destination goes away part-way through the import: the first chunks land, then the connection drops.
        cut.cutAfter(300_000);
        const broken = await split(host, ["transfer"], PROXY_PORT);
        check("a transfer cut off mid-import fails", broken.status !== 0, broken.output.slice(-400));
        cut.heal();
        const retry = await split(host, ["transfer"]);
        check("a second transfer after the failure succeeds", retry.status === 0, retry.output.slice(-1200));

        const noFiles = await split(host, ["verify"]);
        check("verify without the file copy fails", noFiles.status !== 0 && /files report/.test(noFiles.output), noFiles.output.slice(-400));
        const verified = await split(host, ["verify", "--skip-files"]);
        check("verify --skip-files passes against the local destination", verified.status === 0, verified.output.slice(-600));

        const sums = await call("GET", target, `/admin/v1/apps/${source.appId}/checksums`, ADMIN.target);
        const total = (sums.body.logs as Array<{ eventCount: number }>).reduce((sum, log) => sum + log.eventCount, 0);
        check(`the destination holds every event (${source.events})`, total === source.events, `found ${total}`);
        const foreign = await call("GET", target, "/logs", source.token);
        check("the destination refuses the source's credential", foreign.status === 401 || foreign.status === 403, `${foreign.status}`);

        const moved = await split(host, ["fence", "--mode", "moved"]);
        check("the source can be marked moved", moved.status === 0, moved.output.slice(-300));
    } finally {
        cut.server.close();
        for (const child of children) child.kill("SIGKILL");
        if (argv.includes("--keep")) console.log(`Kept ${root}`);
        else rmSync(root, { recursive: true, force: true });
    }
    console.log(failures === 0 ? "\nThe rehearsal passed." : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
}

await main();
