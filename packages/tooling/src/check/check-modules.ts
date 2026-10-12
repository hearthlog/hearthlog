#!/usr/bin/env npx tsx
/**
 * Module boundary check.
 *
 * A module (`modules/<name>/`) may import only the platform's published API
 * (`@hearthlog/sdk/*`, `@hearthlog/contracts`), Svelte and SvelteKit (`svelte`,
 * `$app/*`, `@sveltejs/kit`), icons, its declared third-party dependencies, and its own files;
 * its tests may also use Vitest, Node built-ins, and `@hearthlog/sdk/testing`.
 * Worker code (`src/server/`) may import only the SDK's Worker-safe entries.
 * It may not reach into the app (`#lib`, `$lib`, relative paths leaving the
 * module) or into another module. The app may import a module only through
 * the generated files the composer writes.
 *
 * Usage: pnpm check:modules
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostRoot } from "../root.js";

const ROOT = hostRoot();
const SOURCE = /\.(ts|svelte|js)$/;
const IMPORT = /(?:^|[^\w$.])(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function files(directory: string): string[] {
    // A checkout that lacks a directory (a module repository, a scratch workspace) has nothing to scan there.
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap((name) => {
        if (name === "node_modules" || name.startsWith(".")) return [];
        const path = join(directory, name);
        return statSync(path).isDirectory() ? files(path) : SOURCE.test(name) ? [path] : [];
    });
}

function specifiers(path: string): string[] {
    return [...readFileSync(path, "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]!).filter(Boolean);
}

export function moduleImportProblem(specifier: string, file: string, moduleRoot: string, allowedPackages: readonly string[]): string | null {
    if (specifier.startsWith("#lib") || specifier.startsWith("$lib")) return "imports the app directly";
    if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        return target === moduleRoot || target.startsWith(moduleRoot + sep) ? null : "leaves the module with a relative path";
    }
    if (specifier.startsWith("@hearthlog/module-")) return "imports another module";
    // Worker code must not drag the browser app into the gateway bundle.
    if (file.includes(`${sep}src${sep}server${sep}`)) {
        const WORKER_SAFE = ["server", "server-testing", "entities", "axis", "format"];
        if (specifier.startsWith("@hearthlog/sdk/") && !WORKER_SAFE.includes(specifier.slice("@hearthlog/sdk/".length))) {
            return "pulls browser code into Worker code (use @hearthlog/sdk/server or entities)";
        }
        if (specifier === "svelte" || specifier.startsWith("svelte/") || specifier.startsWith("$app/") || specifier.startsWith("~icons/")) {
            return "uses a browser-only package in Worker code";
        }
    }
    if (specifier.startsWith("@hearthlog/sdk/") || specifier === "@hearthlog/contracts") return null;
    // The framework: `redirect`, `error`, and the like.
    if (specifier === "@sveltejs/kit" && !file.includes(`${sep}src${sep}server${sep}`)) return null;
    if (specifier === "svelte" || specifier.startsWith("svelte/") || specifier.startsWith("$app/") || specifier.startsWith("~icons/")) return null;
    // Tests run under Vitest in Node.
    if (/\.test\.ts$/.test(file) && (specifier === "vitest" || specifier.startsWith("node:"))) return null;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    return allowedPackages.includes(name) ? null : `uses ${name}, which its package.json does not declare`;
}

/** What the installed modules define, from the catalog the composer generates. */
export interface ModuleDomain {
    /** Entity names and table names, quoted in code. */
    names: string[];
    /** Event types (`TRANSACTION_ADDED`) of every module-owned entity. */
    eventTypes: string[];
}

/**
 * The names the installed modules define: their entity and table names (from the generated module
 * catalog) and event types (from the Ledger's generated contracts). A checkout without those
 * generated files, such as a module repository or a scratch workspace, has none to guard.
 */
export async function loadModuleDomain(root = ROOT): Promise<ModuleDomain> {
    const catalog = join(root, ".generated/src/modules.generated.ts");
    const contracts = join(root, ".generated/src/event-schemas.generated.ts");
    if (!existsSync(catalog) || !existsSync(contracts)) return { names: [], eventTypes: [] };
    const { MODULE_ENTITY_DEFINITIONS } = (await import(catalog)) as { MODULE_ENTITY_DEFINITIONS: ReadonlyArray<{ name: string; table: string }> };
    const { EVENT_OWNERS } = (await import(contracts)) as { EVENT_OWNERS: Record<string, string> };
    return {
        names: [...new Set(MODULE_ENTITY_DEFINITIONS.flatMap((definition) => [definition.name, definition.table]))],
        eventTypes: Object.entries(EVENT_OWNERS).filter(([, owner]) => owner !== "core").map(([type]) => type),
    };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The core must not name a module's feature, entity, table, or event type: it learns them from the
 * catalog and contracts the composer generates. A quoted feature id (`'finance'`), a quoted entity
 * or table name, or a module's event type in core code (not comments, tests, or generated files)
 * means a domain leaked back in.
 */
export function coreNamesNoDomain(
    root = ROOT,
    directories = ["worker", "ledger/src", "packages/tooling/src/host", "packages/cloudflare/src", "packages/ledger/src", "packages/ledger-admin/src", "packages/contracts/src", "packages/runtime/src", "packages/ui/src"],
    domain: ModuleDomain = { names: [], eventTypes: [] },
): string[] {
    const modulesDirectory = join(root, "modules");
    const featureIds = (existsSync(modulesDirectory) ? readdirSync(modulesDirectory) : []).flatMap((name) => {
        const manifest = join(modulesDirectory, name, "hearthlog.module.json");
        if (!existsSync(manifest)) return [];
        return (JSON.parse(readFileSync(manifest, "utf8")) as { features?: Array<{ id: string }> }).features?.map((feature) => feature.id) ?? [];
    });
    const quotedNames = [...new Set([...featureIds, ...domain.names])];
    if (!quotedNames.length && !domain.eventTypes.length) return [];
    const quoted = quotedNames.length ? new RegExp(`(["'\`])(${quotedNames.map(escapeRegExp).join("|")})\\1`) : null;
    const events = domain.eventTypes.length ? new RegExp(`\\b(${domain.eventTypes.map(escapeRegExp).join("|")})\\b`) : null;
    const problems: string[] = [];
    for (const directory of directories) {
        for (const file of files(join(root, directory))) {
            if (/\.generated\.ts$|\.test\.ts$|\.d\.ts$|[\\/]generated\.ts$|worker-configuration/.test(file) || file.includes(`${sep}generated${sep}`) || file.includes(`${sep}(modules)${sep}`)) continue;
            readFileSync(file, "utf8").split("\n").forEach((line, index) => {
                // Comments may use a domain as an example.
                if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
                const name = quoted?.exec(line);
                if (name) problems.push(`${relative(root, file)}:${index + 1}: the core names ${name[1]}${name[2]}${name[1]}`);
                const event = events?.exec(line);
                if (event) problems.push(`${relative(root, file)}:${index + 1}: the core names the event type ${event[1]}`);
            });
        }
    }
    return problems;
}

/**
 * Generated files (the module catalog, schema, types, and the like) are imported only through
 * `#generated/*`, which the host maps to wherever its build writes them. A relative or `#lib` path
 * to one would break the day the file is no longer in this tree. The SDK facade, which still reaches
 * into `src/lib` by relative path, and the generated files themselves are exempt.
 */
export function directGeneratedImports(root = ROOT, directories = ["src", "worker", "ledger", "scripts", "calendar-public", "packages/tooling/src", "packages/cloudflare/src", "packages/ledger/src", "packages/ledger-admin/src", "packages/contracts/src", "packages/runtime/src", "packages/ui/src"]): string[] {
    const problems: string[] = [];
    const generatedFile = /(^|[\\/])[\w-]+\.generated(\.js|\.ts)?$|(^|[\\/])tenant[\\/]generated(\.js|\.ts)?$/;
    for (const directory of directories) {
        for (const file of files(join(root, directory))) {
            // The scripts' own tests write fixture files whose text looks like imports, and the generators emit import lines.
            if (/\.generated\.ts$|[\\/]generated\.ts$/.test(file) || file.includes(`${sep}generated${sep}`) || file.includes(`${sep}(modules)${sep}`) || ((directory === "scripts" || directory === "packages/tooling/src") && /\.test\.ts$|(compose-modules|generate-[a-z-]+)\.ts$/.test(file))) continue;
            for (const specifier of specifiers(file)) {
                if ((specifier.startsWith(".") || specifier.startsWith("#lib")) && generatedFile.test(specifier)) {
                    problems.push(`${relative(root, file)}: "${specifier}" is a generated file (import it through #generated/*)`);
                }
            }
        }
    }
    return problems;
}

export function checkBoundaries(root = ROOT, domain?: ModuleDomain): string[] {
    const problems: string[] = [];
    const modulesDirectory = join(root, "modules");
    // A platform workspace or a tenant repository has no modules directory.
    for (const name of existsSync(modulesDirectory) ? readdirSync(modulesDirectory) : []) {
        const moduleRoot = join(modulesDirectory, name);
        if (!statSync(moduleRoot).isDirectory()) continue;
        const packageJson = JSON.parse(readFileSync(join(moduleRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        const allowed = Object.keys(packageJson.dependencies ?? {});
        // A module's anonymous public Worker is part of the module; its build config is tooling.
        const sourceFiles = [join(moduleRoot, "src"), join(moduleRoot, "public")]
            .filter((directory) => existsSync(directory))
            .flatMap((directory) => files(directory))
            .filter((file) => !/vite\.config\.ts$/.test(file));
        for (const file of sourceFiles) {
            for (const specifier of specifiers(file)) {
                const problem = moduleImportProblem(specifier, file, moduleRoot, allowed);
                if (problem) problems.push(`${relative(root, file)}: "${specifier}" ${problem}`);
            }
        }
    }
    const generated = /\.generated\.ts$|[\\/]\(modules\)[\\/]/;
    for (const directory of ["src", "worker", "packages"]) {
        for (const file of files(join(root, directory))) {
            if (generated.test(file)) continue;
            for (const specifier of specifiers(file)) {
                if (specifier.startsWith("@hearthlog/module-")) problems.push(`${relative(root, file)}: the core imports a module ("${specifier}")`);
            }
        }
    }
    problems.push(...coreNamesNoDomain(root, undefined, domain));
    problems.push(...directGeneratedImports(root));
    return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const problems = checkBoundaries(ROOT, await loadModuleDomain(ROOT));
    if (problems.length) {
        console.error(`Module boundaries are broken:\n  - ${problems.join("\n  - ")}`);
        process.exitCode = 1;
    } else {
        console.log("Module boundaries hold.");
    }
}
