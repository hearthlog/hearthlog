#!/usr/bin/env npx tsx
/**
 * `hearthlog check-module [<directory>] [--work <dir>] [--keep] [--overrides <file.json>]`
 *
 * Proves that a module repository composes into a site and passes its tests: it generates a throwaway site that
 * enables the module (the starter `hearthlog init` writes, the module installed from the directory), installs it
 * against the platform range, and builds it, which runs the composer, the boundary checks and the Ledger contract
 * generation. Then it runs the module's own unit tests (`vitest`, from the module's directory) with the site's generated
 * files standing in for `@hearthlog/generated`, which the platform packages import and only a site can write.
 * `--overrides` is a JSON object of package name to `file:` tarball, used to run against a platform that is not
 * published yet.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { moduleSettingPlaceholder } from "@hearthlog/contracts";

import { loadModuleAt } from "../compose/compose-modules.js";
import { renderSite } from "./init.js";

export interface CheckModuleOptions {
    directory: string;
    work?: string;
    keep?: boolean;
    overrides?: Record<string, string>;
}

function run(command: string, args: string[], cwd: string): void {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

/** Writes the site into `work` and returns the module's package name. */
export function assembleCheckSite(options: Required<Pick<CheckModuleOptions, "directory" | "work">> & Pick<CheckModuleOptions, "overrides">): string {
    const directory = resolve(options.directory);
    const loaded = loadModuleAt(directory);
    const name = loaded.manifest.package;
    for (const [path, content] of renderSite({ directory: options.work, id: "st", modules: [name], available: [loaded] })) {
        const target = join(options.work, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
    }
    // Required external module variables need harmless placeholders in this isolated build, not operator storage.
    const configPath = join(options.work, "tenants.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const variable of loaded.manifest.server?.vars ?? []) {
        if (variable.optional) continue;
        if ("resource" in variable) {
            config.infrastructure[variable.resource] ??= /Origin$/.test(variable.resource) ? 'https://module-check.example.invalid' : 'module-check';
            continue;
        }
        const settings = ((config.infrastructure.moduleSettings ??= {})[loaded.manifest.id] ??= {});
        settings[variable.setting] ??= moduleSettingPlaceholder(variable);
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const manifestPath = join(options.work, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies[name] = `file:${directory}`;
    const overrides = options.overrides ?? {};
    // A peer the module needs is the site's to provide; without a published platform it comes from the tarball.
    const peers = Object.keys((JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> }).peerDependencies ?? {});
    for (const [dependency, value] of Object.entries(overrides)) {
        if (dependency !== name && (dependency in manifest.dependencies || peers.includes(dependency))) manifest.dependencies[dependency] = value;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (Object.keys(overrides).length > 0) {
        // pnpm 10 reads overrides from pnpm-workspace.yaml, not from package.json.
        appendFileSync(join(options.work, "pnpm-workspace.yaml"), `\noverrides:\n${Object.entries(overrides).map(([dependency, value]) => `  '${dependency}': '${value}'`).join("\n")}\n`);
    }
    return name;
}

/** What the SvelteKit modules the platform imports (`$app/*`) give a unit test: nothing that runs in a browser. */
const APP_STUB = `const noop = () => {};
export const goto = async () => {}, invalidate = async () => {}, invalidateAll = async () => {}, preloadData = async () => ({}), preloadCode = async () => {};
export const afterNavigate = noop, beforeNavigate = noop, onNavigate = noop, pushState = noop, replaceState = noop, disableScrollHandling = noop;
export const browser = false, dev = false, building = false, version = "test";
export const page = { url: new URL("http://localhost/"), params: {}, route: { id: null }, status: 200, error: null, data: {}, state: {}, form: null };
export const navigating = { current: null };
export const base = "", assets = "", resolve = (path) => path, resolveRoute = (path) => path;
`;

/**
 * Vitest's configuration for a module's tests, run from the site so that its generated files are the ones used: the
 * module's directory is the root, the platform source is transformed here (it ships as TypeScript), `$tenant/generated`
 * is the site's tenant module, `$app/*` is a stub, and `cloudflare:workers` is the platform's stub. The platform
 * packages import `@hearthlog/generated` through their own `imports` map, which no alias reaches, so the site's
 * generated package is linked into the module's `node_modules` (see `linkGenerated`).
 */
export function testConfig(directory: string, work: string): string {
    const alias: Array<{ find: string; replacement: string }> = [
        { find: "$tenant/generated", replacement: join(work, ".generated", "sites", "st", "tenant.ts") },
        { find: /^\$app\/.*/ as unknown as string, replacement: join(work, "app-stub.mjs") },
    ];
    // Test the same platform the composed site built, including unreleased --overrides, rather than the module's older dev dependency.
    const sdk = join(work, "node_modules", "@hearthlog", "sdk");
    const sdkManifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")) as { exports: Record<string, string> };
    for (const [entry, file] of Object.entries(sdkManifest.exports)) {
        if (entry.startsWith('./') && typeof file === 'string') alias.push({ find: `@hearthlog/sdk/${entry.slice(2)}`, replacement: join(sdk, file) });
    }
    const stub = join(work, "node_modules", "@hearthlog", "cloudflare", "src", "testing", "cloudflare-workers.ts");
    if (existsSync(stub)) alias.push({ find: "cloudflare:workers", replacement: stub });
    const options = JSON.stringify({ root: directory, resolve: { alias } }, null, 2).replace('"find": {}', '"find": /^\\$app\\/.*/');
    // The platform's `.svelte.ts` files use runes, which need the Svelte compiler.
    return `import { svelte } from "@sveltejs/vite-plugin-svelte";\nconst options = ${options};\noptions.plugins = [svelte()];\noptions.test = { include: ["src/**/*.test.ts"], passWithNoTests: true, server: { deps: { inline: [/@hearthlog\\//] } } };\nexport default options;\n`;
}

/** Links the site's generated package where the platform packages, installed under the module, look for it; returns the link. */
function linkGenerated(directory: string, work: string): string {
    const scope = join(directory, "node_modules", "@hearthlog");
    mkdirSync(scope, { recursive: true });
    const link = join(scope, "generated");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join(work, ".generated"), link, "dir");
    return link;
}

export function checkModule(options: CheckModuleOptions): void {
    const work = options.work ? resolve(options.work) : mkdtempSync(join(tmpdir(), "hearthlog-check-module-"));
    try {
        const name = assembleCheckSite({ directory: options.directory, work, overrides: options.overrides });
        console.log(`Checking ${name} in a throwaway site at ${work}`);
        run("pnpm", ["install", "--no-frozen-lockfile"], work);
        run("pnpm", ["build"], work);
        console.log(`${name} composes into a site and builds.`);
        const config = join(work, "vitest.module.config.mjs");
        writeFileSync(config, testConfig(resolve(options.directory), work));
        writeFileSync(join(work, "app-stub.mjs"), APP_STUB);
        const link = linkGenerated(resolve(options.directory), work);
        try {
            // Run from the site (its Vite configuration resolves relative to it) with the module's own vitest.
            const vitest = join(dirname(createRequire(join(resolve(options.directory), "package.json")).resolve("vitest/package.json")), "vitest.mjs");
            run(process.execPath, [vitest, "run", "--config", config], work);
        } finally {
            rmSync(link, { force: true });
        }
        console.log(`${name} passes its unit tests.`);
    } finally {
        if (!options.keep) rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const argv = process.argv.slice(2);
        const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
        const directory = argv.find((argument, index) => !argument.startsWith("--") && !["--work", "--overrides"].includes(argv[index - 1] ?? "")) ?? ".";
        const overridesFile = value("--overrides");
        checkModule({
            directory,
            work: value("--work"),
            keep: argv.includes("--keep"),
            overrides: overridesFile ? (JSON.parse(readFileSync(resolve(overridesFile), "utf8")) as Record<string, string>) : undefined,
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
