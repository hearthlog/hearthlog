/**
 * `hearthlog dev-ledger [vite options]`: the site against a Ledger of its own on this machine, in one command. The
 * `hearthlog` command builds the generated files first; this starts the site's Ledger Worker (`wrangler dev` on
 * 127.0.0.1:8787, its data in `.wrangler/development/ledger-state/`), provisions the gateway credential the dev server
 * reads (as `provision-local` does), then runs `vite dev` with the arguments given. Stopping either stops both.
 *
 * The Ledger's local secrets are written once to `.wrangler/development/ledger.dev.vars`: random, mode 600, and never
 * committed (a site ignores `.wrangler/`). Delete `.wrangler/development/` to start from an empty Ledger.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_DIRECTORY, siteDirectory } from "../compose/compose-modules.js";
import { activeSiteId, hostRoot } from "../root.js";
import { DEFAULT_LOCAL_LEDGER_URL, ensureLocalLedgerCredential, localLedgerCredentialPath } from "./local-development.js";

export const DEVELOPMENT_DIRECTORY = join(".wrangler", "development");
export const LEDGER_DEV_VARS = join(DEVELOPMENT_DIRECTORY, "ledger.dev.vars");

/** A new site's local Ledger secrets, in the `.dev.vars` format `wrangler dev --env-file` reads. */
export function ledgerDevVars(secret: () => string = () => randomBytes(32).toString("hex")): string {
    return `ADMIN_TOKEN=${secret()}\nTOKEN_SIGNING_KEY_CURRENT=${secret()}\nALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173\n`;
}

/** The `KEY=VALUE` lines of a `.dev.vars` file; blank lines and `#` comments are skipped. */
export function parseDevVars(text: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match && !line.trimStart().startsWith("#")) values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
    return values;
}

/** The Ledger configuration the build wrote for a site: its own (a dedicated Ledger), else the host's shared one. */
export function ledgerConfigPath(siteId: string): string {
    for (const candidate of [join(siteDirectory(siteId), "ledger", "wrangler.jsonc"), join(GENERATED_DIRECTORY, "shared", "ledger", "wrangler.jsonc")]) {
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(`No Ledger configuration for ${siteId} in .generated/: run hearthlog build`);
}

/** A tool's entry script as the site installs it, run with this Node rather than through a package manager. */
function binary(root: string, name: string, bin: string): string {
    const manifestPath = createRequire(join(root, "package.json")).resolve(`${name}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
    if (!entry) throw new Error(`${name} has no ${bin} binary`);
    return join(dirname(manifestPath), entry);
}

async function waitForHealth(url: string, stopped: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 120 && !stopped(); attempt++) {
        try {
            if ((await fetch(new URL("/health", url))).ok) return true;
        } catch {
            // Not listening yet.
        }
        await new Promise((done) => setTimeout(done, 500));
    }
    return false;
}

export async function devLedger(viteArguments: readonly string[]): Promise<number> {
    const root = hostRoot();
    const site = activeSiteId(root);
    const varsPath = join(root, LEDGER_DEV_VARS);
    mkdirSync(join(root, DEVELOPMENT_DIRECTORY), { recursive: true });
    if (!existsSync(varsPath)) {
        writeFileSync(varsPath, ledgerDevVars(), { mode: 0o600 });
        console.log(`Wrote the local Ledger's secrets to ${LEDGER_DEV_VARS}`);
    }
    const adminToken = parseDevVars(readFileSync(varsPath, "utf8")).ADMIN_TOKEN ?? "";
    const ledgerUrl = new URL(DEFAULT_LOCAL_LEDGER_URL);

    const children = new Set<ChildProcess>();
    let stopping = false;
    let exitCode = 0;
    let finished: (code: number) => void = () => {};
    const done = new Promise<number>((resolveDone) => (finished = resolveDone));
    const stop = (code: number) => {
        if (stopping) return;
        stopping = true;
        exitCode = code;
        // Each child leads a process group of its own, so this stops what it started too (wrangler's workerd).
        for (const child of children) {
            try {
                process.kill(-child.pid!, "SIGTERM");
            } catch {
                // Already gone.
            }
        }
        if (children.size === 0) finished(exitCode);
    };
    const start = (script: string, args: readonly string[]) => {
        const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: "inherit", detached: true });
        children.add(child);
        child.on("exit", (code) => {
            children.delete(child);
            stop(code ?? 0);
            if (children.size === 0) finished(exitCode);
        });
    };
    process.on("SIGINT", () => stop(0));
    process.on("SIGTERM", () => stop(0));

    start(binary(root, "wrangler", "wrangler"), [
        "dev",
        "--config", ledgerConfigPath(site),
        "--env-file", varsPath,
        "--persist-to", join(root, DEVELOPMENT_DIRECTORY, "ledger-state"),
        "--ip", ledgerUrl.hostname,
        "--port", ledgerUrl.port,
    ]);
    if (!(await waitForHealth(ledgerUrl.href, () => stopping))) {
        if (!stopping) console.error(`The local Ledger did not answer at ${new URL("/health", ledgerUrl).href}`);
        stop(1);
        return done;
    }
    try {
        const { reused } = await ensureLocalLedgerCredential({ adminToken, baseUrl: ledgerUrl.href, credentialPath: localLedgerCredentialPath(root) });
        console.log(`${reused ? "Reused" : "Provisioned"} the dev server's credential for the local Ledger (token not printed)`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        stop(1);
        return done;
    }
    start(binary(root, "vite", "vite"), ["dev", ...viteArguments]);
    return done;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await devLedger(process.argv.slice(2).filter((argument) => argument !== "--"));
}
