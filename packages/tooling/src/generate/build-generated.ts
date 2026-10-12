#!/usr/bin/env npx tsx
/**
 * `pnpm build:generated`: write everything the build generates, once, for one site.
 *
 *   .generated/src/           the shared package (@hearthlog/generated) for the active site: the module
 *                             catalog, icons, repositories, entity types and schema, data APIs, and the
 *                             Ledger's event schemas
 *   .generated/sites/<id>/    the site's tenant module, boot shell (app.html), and gateway table
 *   routes/, app.css, service-worker/, static/, app.d.ts   the SvelteKit host (see host/write-host.ts), with the
 *                             site's module routes composed into routes/(modules)/
 *
 * A site's modules are the ones in `tenants/<id>/modules.lock.json`. The catalog is written first, in this
 * process, because everything else reads it; the generators that do run in processes of their own, so they
 * see the new catalog. The inputs (tenants.json, the site's files, the lock's manifests and entity
 * definitions, the core entity definitions, and the generators) are hashed; a build with the same hash and
 * the outputs in place does nothing.
 *
 *   pnpm build:generated [--site <id>] [--all-modules] [--check] [--force]
 *
 * The site defaults to VITE_STOR_TENANT, then "st". `--all-modules` writes the catalog of every installed
 * module and nothing else (`pnpm lock:modules` reads it). `--check` fails when the outputs are stale.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCatalog, GENERATED_DIRECTORY, loadModules, modulesInLock, siteDirectory } from "../compose/compose-modules.js";
import { packageDirectory } from "../host/write-host.js";
import { hostRoot } from "../root.js";

const ROOT = hostRoot();
const STATE_PATH = join(GENERATED_DIRECTORY, ".build.json");
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLING = resolve(HERE, "..");

/** What the generators read besides the modules: the core entity definitions, the tooling, the boot shell template. */
const SHARED_INPUTS = [
    "tenants.json",
    "src/routes",
    "static",
].map((path) => join(ROOT, path));
const GENERATOR_INPUTS = [...["generate", "compose", "tenants", "host"].map((folder) => join(TOOLING, folder)), join(TOOLING, "..", "templates")];

export interface BuildOptions {
    siteId: string;
    all?: boolean;
    check?: boolean;
    force?: boolean;
}

interface BuildState {
    hash: string;
    site: string;
    all: boolean;
}

function files(path: string): string[] {
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules" && !entry.name.endsWith(".test.ts"))
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => files(join(path, entry.name)));
}

/** The hash of everything a build of this site and mode reads. */
export function inputHash({ siteId, all = false }: Pick<BuildOptions, "siteId" | "all">): string {
    const installed = loadModules();
    const modules = all ? installed : modulesInLock(installed, siteId);
    const inputs = [
        ...SHARED_INPUTS,
        join(packageDirectory("@hearthlog/contracts"), "src"),
        join(packageDirectory("@hearthlog/shell"), "static"),
        join(packageDirectory("@hearthlog/shell"), "src", "app.template.html"),
        ...GENERATOR_INPUTS,
        ...(all ? [] : files(join(ROOT, "tenants", siteId))),
        ...modules.flatMap(({ directory }) => [join(directory, "hearthlog.module.json"), join(directory, "src", "data")]),
    ];
    const hash = createHash("sha256").update(`${siteId}\0${all}\0`);
    for (const file of inputs.flatMap(files)) {
        hash.update(`${relative(ROOT, file)}\0`).update(readFileSync(file)).update("\0");
    }
    return hash.digest("hex");
}

function outputs(siteId: string, all: boolean): string[] {
    const shared = ["modules", "module-icons", "module-repositories", "types", "schema", "standard-commands", "standard-db", "event-schemas"]
        .map((name) => join(GENERATED_DIRECTORY, "src", `${name}.generated.ts`));
    if (all) return shared.slice(0, 3);
    return [
        ...shared,
        join(siteDirectory(siteId), "tenant.ts"),
        join(siteDirectory(siteId), "app.html"),
        join(siteDirectory(siteId), "server-modules.ts"),
        join(siteDirectory(siteId), "worker.ts"),
        join(siteDirectory(siteId), "wrangler.jsonc"),
        join(GENERATED_DIRECTORY, "routes", "(modules)", "startup.ts"),
        join(GENERATED_DIRECTORY, "routes", "+layout.svelte"),
        join(GENERATED_DIRECTORY, "module-sources.generated.css"),
        join(GENERATED_DIRECTORY, "app.css"),
        join(GENERATED_DIRECTORY, "app.d.ts"),
        join(GENERATED_DIRECTORY, "tsconfig.json"),
        join(GENERATED_DIRECTORY, "service-worker", "index.ts"),
        join(GENERATED_DIRECTORY, "static", "_headers"),
    ];
}

function readState(): BuildState | undefined {
    try {
        return JSON.parse(readFileSync(STATE_PATH, "utf8")) as BuildState;
    } catch {
        return undefined;
    }
}

function isCurrent({ siteId, all = false }: BuildOptions): boolean {
    const state = readState();
    return state !== undefined
        && state.site === siteId
        && state.all === all
        && state.hash === inputHash({ siteId, all })
        && outputs(siteId, all).every((path) => existsSync(path));
}

function runGenerator(script: string, siteId: string): void {
    const result = spawnSync(process.execPath, [...process.execArgv, join(TOOLING, script)], {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, VITE_STOR_TENANT: siteId },
    });
    if (result.status !== 0) throw new Error(`${script} failed`);
}

export async function build(options: BuildOptions): Promise<"built" | "current"> {
    const { siteId, all = false } = options;
    if (!options.force && isCurrent(options)) return "current";
    if (options.check) throw new Error(`The generated files are stale for ${all ? "every module" : `site ${siteId}`} (run pnpm build:generated)`);
    await generateCatalog({ siteId, all });
    if (!all) {
        runGenerator("generate/generate-entities.ts", siteId);
        runGenerator("generate/generate-tenant.ts", siteId);
        runGenerator("host/write-host.ts", siteId);
        runGenerator("compose/compose-modules.ts", siteId);
    }
    mkdirSync(GENERATED_DIRECTORY, { recursive: true });
    const state: BuildState = { hash: inputHash({ siteId, all }), site: siteId, all };
    writeFileSync(STATE_PATH, `${JSON.stringify(state)}\n`, "utf8");
    return "built";
}

async function main(argv: string[]): Promise<void> {
    const site = argv.indexOf("--site");
    const siteId = (site >= 0 ? argv[site + 1] : undefined) ?? (process.env.VITE_STOR_TENANT?.trim() || "st");
    const outcome = await build({ siteId, all: argv.includes("--all-modules"), check: argv.includes("--check"), force: argv.includes("--force") });
    if (outcome === "current" && !argv.includes("--quiet")) console.log(`Generated files are current for ${siteId}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
