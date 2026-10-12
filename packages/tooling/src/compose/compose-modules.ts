#!/usr/bin/env npx tsx
/**
 * Compose the app from the modules in `modules/*`.
 *
 * Two outputs, both derived from each module's `hearthlog.module.json` (read as
 * data; no module code runs here):
 *
 *   --catalog  The module catalog of one site (`--site <id>`, default the
 *              build site) or of every installed module (`--all`): feature
 *              metadata, sub-pages, shortcuts, refresh keys, icons, the data
 *              repositories, and the site's gateway table. Written to the
 *              gitignored `.generated/` by `pnpm build:generated`, which runs
 *              this first because everything else reads it. A site's modules
 *              are the ones in its `tenants/<id>/modules.lock.json`.
 *   (default)  The routes of one tenant (VITE_STOR_TENANT, default "st"):
 *              thin wrappers in the gitignored `src/routes/(modules)/` for
 *              the modules whose features the tenant enables, so a tenant
 *              without a module ships none of its pages.
 *
 * Usage:
 *   pnpm build:generated   (runs both, and the entity and tenant generators)
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { CORE_ROUTE_PATHS } from "../host/core-routes.js";
import { hostRoot } from "../root.js";

import { findCollisions, validateManifest, type ModuleManifest } from "@hearthlog/contracts";

import { CORE_API_PREFIXES, CORE_FEATURE_IDS, CORE_REFRESH_KEYS } from "@hearthlog/contracts/features/core";

// The catalog must build before anything that reads it (tenant-config imports
// the registry, which imports the catalog), so this script resolves the root itself.
const REPOSITORY_ROOT = hostRoot();
const MODULES_DIRECTORY = join(REPOSITORY_ROOT, "modules");
/** The routes the site's own `src/routes/` adds; `pnpm build:generated` merges them into the generated routes. */
const SITE_ROUTES_DIRECTORY = join(REPOSITORY_ROOT, "src", "routes");
const COMPOSED_ROUTES = join(REPOSITORY_ROOT, ".generated", "routes", "(modules)");
/** What the build writes (gitignored): the shared package for the active site and a folder per site built so far. */
export const GENERATED_DIRECTORY = join(REPOSITORY_ROOT, ".generated");
export function siteDirectory(siteId: string): string {
    return join(GENERATED_DIRECTORY, "sites", siteId);
}
/** The server code of the modules a site enables, which the site's gateway Worker bundles. */
export function gatewayModulesPath(siteId: string): string {
    return join(siteDirectory(siteId), "server-modules.ts");
}
/** The site's gateway Worker entry: Wrangler's `main`. */
export function gatewayEntryPath(siteId: string): string {
    return join(siteDirectory(siteId), "worker.ts");
}
/** Each tenant lists the module stylesheets and sources it ships for Tailwind (written by `pnpm build:generated`). */
export const MODULE_SOURCES_PATH = join(REPOSITORY_ROOT, ".generated", "module-sources.generated.css");
export const CATALOG_PATH = join(GENERATED_DIRECTORY, "src", "modules.generated.ts");
export const ICONS_PATH = join(GENERATED_DIRECTORY, "src", "module-icons.generated.ts");
export const REPOSITORIES_PATH = join(GENERATED_DIRECTORY, "src", "module-repositories.generated.ts");

export interface LoadedModule {
    directory: string;
    manifest: ModuleManifest;
}

export function loadModuleAt(moduleDirectory: string): LoadedModule {
    const path = join(moduleDirectory, "hearthlog.module.json");
    const manifest = validateManifest(JSON.parse(readFileSync(path, "utf8")), relative(REPOSITORY_ROOT, path));
    const packageJson = JSON.parse(readFileSync(join(moduleDirectory, "package.json"), "utf8")) as { name?: string };
    if (packageJson.name !== manifest.package) {
        throw new Error(`${manifest.id}: package.json name ${String(packageJson.name)} does not match ${manifest.package}`);
    }
    for (const route of manifest.routes) {
        for (const file of [route.page, route.load, ...(manifest.layouts ?? []).flatMap((layout) => [layout.page, layout.load]), manifest.data?.definitions, manifest.data?.repositories, manifest.server?.entry, manifest.startup].filter((value): value is string => Boolean(value))) {
            if (!existsSync(join(moduleDirectory, file))) throw new Error(`${manifest.id}: ${file} does not exist`);
        }
    }
    return { directory: moduleDirectory, manifest };
}

/** The packages the host installs that carry a module manifest: its dependencies with a `hearthlog.module.json` in their root. */
export function installedModuleDirectories(root = REPOSITORY_ROOT): string[] {
    const packagePath = join(root, "package.json");
    if (!existsSync(packagePath)) return [];
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return Object.keys({ ...packageJson.devDependencies, ...packageJson.dependencies })
        .map((name) => join(root, "node_modules", name))
        .filter((directory) => existsSync(join(directory, "hearthlog.module.json")))
        .map((directory) => realpathSync(directory));
}

/**
 * The modules a host has: those in its `modules/` folder (a checkout that develops them) and the packages
 * it installs (a site that uses them). Given a directory, only that folder is scanned.
 */
export function loadModules(directory?: string): LoadedModule[] {
    const scanned = (folder: string): string[] => existsSync(folder)
        ? readdirSync(folder, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "hearthlog.module.json")))
            .map((entry) => join(folder, entry.name))
        : [];
    const directories = directory !== undefined ? scanned(directory) : [...scanned(MODULES_DIRECTORY), ...installedModuleDirectories()];
    const unique = [...new Map(directories.map((candidate) => [realpathSync(candidate), candidate])).values()];
    return unique.map(loadModuleAt).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

/** URL paths of the app's own routes, outside the composed group: the core routes and the site's `src/routes/`. */
export function coreRoutePaths(directory = SITE_ROUTES_DIRECTORY): string[] {
    const paths: string[] = [...CORE_ROUTE_PATHS];
    if (!existsSync(directory)) return paths;
    const visit = (current: string, url: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === "(modules)") continue;
            const segment = /^\(.+\)$/.test(entry.name) ? "" : `/${entry.name}`;
            const next = join(current, entry.name);
            if (existsSync(join(next, "+page.svelte"))) paths.push(url + segment || "/");
            visit(next, url + segment);
        }
    };
    visit(directory, "");
    return paths;
}

export function checkComposition(modules: readonly LoadedModule[]): void {
    const problems = findCollisions(modules.map((module) => module.manifest), {
        featureIds: CORE_FEATURE_IDS,
        routePaths: coreRoutePaths(),
        refreshKeys: CORE_REFRESH_KEYS,
        apiPrefixes: CORE_API_PREFIXES,
    });
    if (problems.length > 0) throw new Error(`Modules cannot be composed:\n  - ${problems.join("\n  - ")}`);
}

/** A data entry (`./src/data/x.ts`) as the package exports it. */
function exportedData(manifest: ModuleManifest, file: string): string {
    const match = /^\.\/src\/data\/(.+)\.ts$/.exec(file);
    if (!match) throw new Error(`${manifest.id}: ${file} must live in src/data/`);
    return `${manifest.package}/data/${match[1]}.js`;
}

function exportedServer(manifest: ModuleManifest): string {
    const match = /^\.\/src\/server\/(.+)\.ts$/.exec(manifest.server!.entry);
    if (!match) throw new Error(`${manifest.id}: server.entry must live in src/server/`);
    return `${manifest.package}/server/${match[1]}.js`;
}

function exportedStartup(manifest: ModuleManifest): string {
    const match = /^\.\/src\/(.+)\.ts$/.exec(manifest.startup!);
    if (!match) throw new Error(`${manifest.id}: startup must be a .ts file in src/`);
    return `${manifest.package}/${match[1]}.js`;
}

function exportedStyles(manifest: ModuleManifest): string {
    const match = /^\.\/src\/(.+\.css)$/.exec(manifest.styles!);
    if (!match) throw new Error(`${manifest.id}: styles must be a .css file in src/`);
    return `${manifest.package}/${match[1]}`;
}

function exportedAttention(manifest: ModuleManifest): string {
    const match = /^\.\/src\/(.+)\.ts$/.exec(manifest.attention!);
    if (!match) throw new Error(`${manifest.id}: attention must be a .ts file in src/`);
    return `${manifest.package}/${match[1]}.js`;
}

/** Entry path inside a module, as its package exports it. */
function exportedEntry(manifest: ModuleManifest, file: string): string {
    const match = /^\.\/src\/pages\/(.+)\.(svelte|ts)$/.exec(file);
    if (!match) throw new Error(`${manifest.id}: ${file} must live in src/pages/ to be routed`);
    return `${manifest.package}/pages/${match[1]}.${match[2] === "ts" ? "js" : "svelte"}`;
}

const HEADER = "// AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts from modules/*/hearthlog.module.json. Do not edit.";

/**
 * The entity definitions of the modules that ship any, in module order. They are plain data and are written into the
 * catalog as literals: the catalog is imported by the site's Vite configuration, which Node loads, and Node refuses
 * the TypeScript of a module installed under `node_modules`.
 */
export async function loadEntityDefinitions(modules: readonly LoadedModule[]): Promise<unknown[]> {
    const lists = await Promise.all(modules.filter(({ manifest }) => manifest.data?.definitions).map(async ({ directory, manifest }) => {
        const loaded = await import(pathToFileURL(join(directory, manifest.data!.definitions!)).href) as { ENTITY_DEFINITIONS?: unknown[] };
        if (!Array.isArray(loaded.ENTITY_DEFINITIONS)) throw new Error(`${manifest.id}: ${manifest.data!.definitions} must export ENTITY_DEFINITIONS`);
        if (JSON.stringify(loaded.ENTITY_DEFINITIONS) === undefined || !isDeepStrictEqual(JSON.parse(JSON.stringify(loaded.ENTITY_DEFINITIONS)), loaded.ENTITY_DEFINITIONS)) {
            throw new Error(`${manifest.id}: ENTITY_DEFINITIONS must be plain data (no functions, patterns, or undefined values)`);
        }
        return loaded.ENTITY_DEFINITIONS;
    }));
    return lists.flat();
}

export function renderCatalog(modules: readonly LoadedModule[], entityDefinitions: readonly unknown[]): string {
    const features = modules.flatMap(({ manifest }) => manifest.features.map((feature) => ({ module: manifest.id, ...feature })));
    const refreshKeys = modules.flatMap(({ manifest }) => manifest.refreshKeys ?? []);
    const ids = features.map((feature) => JSON.stringify(feature.id));
    const sections = modules.flatMap(({ manifest }) => manifest.section ? [manifest.section] : []);
    const routes = modules.flatMap(({ manifest }) => manifest.routes.map((route) => ({
        path: route.path,
        ...(route.fitsScreen ? { fitsScreen: true } : {}),
        ...(route.keepMounted ? { keepMounted: true } : {}),
        ...(route.resolvesTo ? { resolvesTo: route.resolvesTo } : {}),
        ...(route.requires ? { requires: route.requires } : {}),
    })));
    const redirects = modules.flatMap(({ manifest }) => manifest.redirects ?? []);
    const integrationKinds = modules.flatMap(({ manifest }) => manifest.integrationKinds ?? []);
    const aiCapabilities = modules.flatMap(({ manifest }) => manifest.aiCapabilities ?? []);
    const localStores = modules.flatMap(({ manifest }) => manifest.localStores ?? []);
    const projections = modules.flatMap(({ manifest }) => manifest.projectionVersion === undefined ? [] : [{
        module: manifest.id,
        version: manifest.projectionVersion,
        features: manifest.features.map((feature) => feature.id),
    }]);
    return [
        HEADER,
        "",
        "import type { ModuleFeature, ModuleRedirect, ModuleRoute, ModuleSection } from '@hearthlog/contracts';",
        "import type { EntityDefinition } from '@hearthlog/contracts/event/entity-definitions';",
        "",
        `export type ModuleFeatureId = ${ids.length ? ids.join(" | ") : "never"};`,
        "",
        "export const MODULE_FEATURES: ReadonlyArray<ModuleFeature & { id: ModuleFeatureId; module: string }> = " +
            `${JSON.stringify(features, null, 4)};`,
        "",
        `export const MODULE_REFRESH_KEYS: readonly \`\${string}:\${string}\`[] = ${JSON.stringify(refreshKeys)};`,
        "",
        `export const MODULE_LOCAL_STORES: ReadonlyArray<{ database: string; label: string; fileStore?: string; kinds?: boolean }> = ${JSON.stringify(localStores, null, 4)};`,
        "",
        `export const MODULE_SECTIONS: readonly ModuleSection[] = ${JSON.stringify(sections, null, 4)};`,
        "",
        `export const MODULE_ROUTES: ReadonlyArray<Pick<ModuleRoute, 'path' | 'fitsScreen' | 'keepMounted' | 'resolvesTo' | 'requires'>> = ${JSON.stringify(routes, null, 4)};`,
        "",
        `export const MODULE_REDIRECTS: readonly ModuleRedirect[] = ${JSON.stringify(redirects, null, 4)};`,
        "",
        `export const MODULE_PROJECTIONS: ReadonlyArray<{ module: string; version: number; features: readonly string[] }> = ${JSON.stringify(projections, null, 4)};`,
        "",
        `export type ModuleAiCapability = ${aiCapabilities.length ? aiCapabilities.map((id) => JSON.stringify(id)).join(" | ") : "never"};`,
        "",
        `export const MODULE_AI_CAPABILITIES: readonly ModuleAiCapability[] = ${JSON.stringify(aiCapabilities)};`,
        "",
        `export type ModuleIntegrationKind = ${integrationKinds.length ? integrationKinds.map((entry) => JSON.stringify(entry.kind)).join(" | ") : "never"};`,
        "",
        `export const MODULE_INTEGRATION_KINDS: ReadonlyArray<{ kind: ModuleIntegrationKind; feature: ModuleFeatureId }> = ${JSON.stringify(integrationKinds, null, 4)} as ReadonlyArray<{ kind: ModuleIntegrationKind; feature: ModuleFeatureId }>;`,
        "",
        `export const MODULE_ENTITY_DEFINITIONS: readonly EntityDefinition[] = ${JSON.stringify(entityDefinitions, null, 4)};`,
        "",
    ].join("\n");
}

/** Browser-only: the read repositories modules add to `queryDatabase`. */
export function renderRepositories(modules: readonly LoadedModule[]): string {
    const withRepositories = modules.filter(({ manifest }) => manifest.data?.repositories);
    return [
        HEADER,
        "",
        "import type { ReadModelSession } from '@hearthlog/runtime/db/read-session.js';",
        ...withRepositories.map(({ manifest }, index) => `import { createRepositories as moduleRepositories${index} } from '${exportedData(manifest, manifest.data!.repositories!)}';`),
        "",
        "export function createModuleRepositories(session: ReadModelSession) {",
        "    return {",
        ...withRepositories.map((_, index) => `        ...moduleRepositories${index}(session),`),
        "    };",
        "}",
        "",
    ].join("\n");
}

export function renderIcons(modules: readonly LoadedModule[]): string {
    const features = modules.flatMap(({ manifest }) => manifest.features);
    const sections = modules.flatMap(({ manifest }) => manifest.section ? [manifest.section] : []);
    const calendarIcons = [...new Set(modules.flatMap(({ manifest }) => manifest.calendarIcons ?? []))].sort();
    return [
        HEADER,
        "",
        "import type { Component } from 'svelte';",
        ...features.map((feature, index) => `import ModuleIcon${index} from '~icons/mdi/${feature.icon}';`),
        ...sections.map((section, index) => `import SectionIcon${index} from '~icons/mdi/${section.icon}';`),
        ...calendarIcons.map((icon, index) => `import CalendarIcon${index} from '~icons/mdi/${icon}';`),
        "import type { ModuleFeatureId } from './modules.generated.js';",
        "",
        "export const MODULE_ICONS: Record<ModuleFeatureId, Component> = {",
        ...features.map((feature, index) => `    ${JSON.stringify(feature.id)}: ModuleIcon${index},`),
        "};",
        "",
        "export const MODULE_SECTION_ICONS: Record<string, Component> = {",
        ...sections.map((section, index) => `    ${JSON.stringify(section.id)}: SectionIcon${index},`),
        "};",
        "",
        "/** Icons modules use on their calendar sources, by `mdi` name. */",
        "export const MODULE_CALENDAR_ICONS: Record<string, Component> = {",
        ...calendarIcons.map((icon, index) => `    ${JSON.stringify(icon)}: CalendarIcon${index},`),
        "};",
        "",
    ].join("\n");
}

/**
 * The gateway Worker's module table for one site: only the server entries of
 * modules the site enables, so a site without Gallery bundles no Gallery code.
 * The site's gateway entry (`worker.ts`) imports this file.
 */
export function renderGatewayModules(siteId: string, modules: readonly LoadedModule[]): string {
    const servers = modules.filter(({ manifest }) => manifest.server);
    return [
        `// AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts for site "${siteId}". Do not edit.`,
        "",
        "import type { ServerModule } from '@hearthlog/contracts';",
        ...servers.map(({ manifest }, index) => `import serverModule${index} from '${exportedServer(manifest)}';`),
        "",
        `export const SERVER_MODULES: ReadonlyArray<ServerModule<Env>> = [${servers.map((_, index) => `serverModule${index}`).join(", ")}];`,
        "",
    ].join("\n");
}

export function renderModuleSources(modules: readonly LoadedModule[]): string {
    const styles = modules.filter(({ manifest }) => manifest.styles).map(({ manifest }) => `@import '${exportedStyles(manifest)}';`);
    const sources = modules.map(({ directory }) => `@source '${relative(dirname(MODULE_SOURCES_PATH), join(directory, "src")).split(sep).join("/")}';`);
    return ["/* AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts. Do not edit. */", ...styles, ...sources, ""].join("\n");
}

/** Browser code a tenant's modules run at startup (Gallery's upload coordinator). */
export function renderStartup(modules: readonly LoadedModule[]): string {
    const starters = modules.filter(({ manifest }) => manifest.startup);
    const watchers = modules.filter(({ manifest }) => manifest.attention);
    return [
        `// AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts. Do not edit.`,
        "",
        "import type { AttentionContribution } from '@hearthlog/contracts';",
        ...starters.map(({ manifest }, index) => `import { start as start${index} } from '${exportedStartup(manifest)}';`),
        ...watchers.map(({ manifest }, index) => `import { attention as attention${index} } from '${exportedAttention(manifest)}';`),
        "",
        "/** What the composed modules say about late or upcoming work (navigation badges, native reminders). */",
        `export const attentionContributions: readonly AttentionContribution[] = [${watchers.map((_, index) => `attention${index}`).join(", ")}];`,
        "",
        "/** Starts every composed module; returns one function that stops them all. */",
        "export function startModules(): () => void {",
        `    const stops: unknown[] = [${starters.map((_, index) => `start${index}()`).join(", ")}];`,
        "    return () => { for (const stop of stops) if (typeof stop === 'function') stop(); };",
        "}",
        "",
    ].join("\n");
}

export function renderRoute(manifest: ModuleManifest, route: ModuleManifest["routes"][number]): { page: string; load: string | null } {
    const header = `<!-- AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts from ${manifest.id}. Do not edit. -->`;
    return {
        page: [
            header,
            '<script lang="ts">',
            `    import Page from "${exportedEntry(manifest, route.page)}";`,
            "    let props = $props();",
            "</script>",
            "",
            "<Page {...props} />",
            "",
        ].join("\n"),
        load: route.load ? `${HEADER}\nexport { load } from "${exportedEntry(manifest, route.load)}";\n` : null,
    };
}

/** A layout wrapper: the module's layout component gets the route's props, children included. */
export function renderLayout(manifest: ModuleManifest, layout: NonNullable<ModuleManifest["layouts"]>[number]): { page: string; load: string | null } {
    const header = `<!-- AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts from ${manifest.id}. Do not edit. -->`;
    return {
        page: [
            header,
            '<script lang="ts">',
            `    import Layout from "${exportedEntry(manifest, layout.page)}";`,
            "    let { children, ...props } = $props();",
            "</script>",
            "",
            // SvelteKit requires the layout file itself to render its children.
            "<Layout {...props}>{@render children()}</Layout>",
            "",
        ].join("\n"),
        load: layout.load ? `${HEADER}\nexport { load } from "${exportedEntry(manifest, layout.load)}";\n` : null,
    };
}

/** The modules a tenant composes: those with at least one enabled feature. */
export function modulesForFeatures(modules: readonly LoadedModule[], features: readonly string[]): LoadedModule[] {
    return modules.filter(({ manifest }) => manifest.features.some((feature) => features.includes(feature.id)));
}

/** The modules a site ships, as its lock names them. */
export function modulesInLock(modules: readonly LoadedModule[], siteId: string): LoadedModule[] {
    const path = join(REPOSITORY_ROOT, "tenants", siteId, "modules.lock.json");
    if (!existsSync(path)) throw new Error(`tenants/${siteId}/modules.lock.json is missing (run pnpm lock:modules)`);
    const ids = (JSON.parse(readFileSync(path, "utf8")) as { modules: Array<{ id: string }> }).modules.map(({ id }) => id);
    const unknown = ids.filter((id) => !modules.some(({ manifest }) => manifest.id === id));
    if (unknown.length > 0) throw new Error(`tenants/${siteId}/modules.lock.json names modules that are not installed: ${unknown.join(", ")}`);
    return modules.filter(({ manifest }) => ids.includes(manifest.id));
}

async function writeIfChanged(path: string, content: string): Promise<void> {
    if (existsSync(path) && (await readFile(path, "utf8")) === content) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
}

/** The gateway Worker's entry: the code is `@hearthlog/cloudflare`; the site hands it the server modules it enables. */
export function renderGatewayEntry(siteId: string): string {
    return [
        `// AUTO-GENERATED by packages/tooling/src/compose/compose-modules.ts for site "${siteId}". Do not edit.`,
        "",
        "import { createGateway } from '@hearthlog/cloudflare/gateway.js';",
        "",
        "import { SERVER_MODULES } from './server-modules.js';",
        "",
        "export { CalendarFeedRenderer } from '@hearthlog/cloudflare/calendar-feed-renderer.js';",
        "export { proxyAccessSession, proxyLedgerAdminRequest, proxyLedgerRequest, serveAssetOrAppShell } from '@hearthlog/cloudflare/gateway.js';",
        "",
        "export default createGateway(SERVER_MODULES);",
        "",
    ].join("\n");
}

export interface CatalogOptions {
    /** The site whose modules the catalog covers; ignored with `all`. */
    siteId: string;
    /** Every installed module, for the commands that read the lock's source (`pnpm lock:modules`). */
    all?: boolean;
    check?: boolean;
}

export async function generateCatalog({ siteId, all = false, check = false }: CatalogOptions): Promise<void> {
    const installed = loadModules();
    checkComposition(installed);
    const modules = all ? installed : modulesInLock(installed, siteId);
    const outputs = new Map([
        [CATALOG_PATH, renderCatalog(modules, await loadEntityDefinitions(modules))],
        [ICONS_PATH, renderIcons(modules)],
        [REPOSITORIES_PATH, renderRepositories(modules)],
    ]);
    if (!all) {
        outputs.set(gatewayModulesPath(siteId), renderGatewayModules(siteId, modules));
        outputs.set(gatewayEntryPath(siteId), renderGatewayEntry(siteId));
    }
    const stale: string[] = [];
    for (const [path, content] of outputs) {
        if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
        if (check) stale.push(relative(REPOSITORY_ROOT, path));
        else await writeIfChanged(path, content);
    }
    if (stale.length) throw new Error(`Generated module files are stale: ${stale.join(", ")} (run pnpm build:generated)`);
    console.log(`${check ? "Checked" : "Generated"} the catalog of ${modules.length} module(s)${all ? " (every installed module)" : ` for ${siteId}`}.`);
}

async function composeRoutes(): Promise<void> {
    const modules = loadModules();
    checkComposition(modules);
    const siteId = process.env.VITE_STOR_TENANT?.trim() || "st";
    const { loadTenantConfig, siteById } = await import("../tenants/tenant-config.js");
    const { sites } = await loadTenantConfig(undefined, { only: siteId });
    const site = siteById(sites, siteId);
    const selected = modulesForFeatures(modules, site.features);
    await rm(COMPOSED_ROUTES, { recursive: true, force: true });
    for (const { manifest } of selected) {
        for (const route of manifest.routes) {
            const directory = join(COMPOSED_ROUTES, ...route.path.split("/").filter(Boolean));
            const rendered = renderRoute(manifest, route);
            await writeIfChanged(join(directory, "+page.svelte"), rendered.page);
            if (rendered.load) await writeIfChanged(join(directory, "+page.ts"), rendered.load);
        }
    }
    for (const { manifest } of selected) {
        for (const layout of manifest.layouts ?? []) {
            const directory = join(COMPOSED_ROUTES, ...layout.path.split("/").filter(Boolean));
            const rendered = renderLayout(manifest, layout);
            await writeIfChanged(join(directory, "+layout.svelte"), rendered.page);
            if (rendered.load) await writeIfChanged(join(directory, "+layout.ts"), rendered.load);
        }
    }
    await writeIfChanged(join(COMPOSED_ROUTES, "startup.ts"), renderStartup(selected));
    await writeIfChanged(MODULE_SOURCES_PATH, renderModuleSources(selected));
    console.log(`Composed ${selected.length} of ${modules.length} module(s) for ${site.id}: ${selected.map(({ manifest }) => manifest.id).join(", ") || "none"}.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const site = argv.indexOf("--site");
    const siteId = (site >= 0 ? argv[site + 1] : undefined) ?? (process.env.VITE_STOR_TENANT?.trim() || "st");
    if (argv.includes("--catalog")) await generateCatalog({ siteId, all: argv.includes("--all"), check: argv.includes("--check") });
    else await composeRoutes();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
