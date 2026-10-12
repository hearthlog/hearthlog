#!/usr/bin/env npx tsx
/**
 * Layering check for the split of `src/lib` into packages (plan, step A3).
 *
 * `scripts/layers.json` assigns every file of `src/lib` to a layer (kernel, ui, runtime, shell) and
 * says which layers each may import. This fails when a file imports a layer it may not, so the
 * packages the layers become can never need each other in a cycle. Tests are not checked.
 *
 * Usage: pnpm check:layers
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_ROOT } from "../root.js";

// Layers are a property of the platform's packages, wherever the check runs from.
const ROOT = PLATFORM_ROOT;
const IMPORT = /(?:^|[^\w$.])(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

export interface LayerConfig {
    root: string;
    default: string;
    layers: Array<{ name: string; may: string[]; include: string[] }>;
    /** Extracted packages (`packages/<name>`) and the other `@hearthlog/*` packages each may import. */
    packages?: Record<string, { may: string[]; allowOutside?: string[] }>;
}

export function layerOf(path: string, config: LayerConfig): string {
    const normalized = path.split(sep).join("/");
    return config.layers.find((layer) => layer.include.some((glob) => matchesGlob(normalized, glob)))?.name ?? config.default;
}

function sourceFiles(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : sourceFiles(path);
        return /\.(ts|svelte|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name) ? [path] : [];
    });
}

/** The file an import points at inside the root, or null for a package or a file outside it. */
export function resolveImport(from: string, specifier: string, root: string): string | null {
    let target: string;
    if (specifier.startsWith("#lib/")) target = join(root, specifier.slice("#lib/".length));
    else if (specifier.startsWith(".")) target = resolve(dirname(from), specifier);
    else return null;
    if (!target.startsWith(root + sep)) return null;
    const stem = target.endsWith(".js") ? target.slice(0, -3) : target;
    const candidates = [target, `${stem}.ts`, `${stem}.svelte.ts`, `${target}.ts`, `${target}.svelte`, `${target}.svelte.ts`, join(target, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

export function checkLayers(rootDirectory = ROOT, config: LayerConfig = JSON.parse(readFileSync(join(rootDirectory, "scripts", "layers.json"), "utf8"))): { problems: string[]; counts: Record<string, number> } {
    const root = join(rootDirectory, config.root);
    const counts: Record<string, number> = {};
    const problems: string[] = [];
    const known = new Set(config.layers.map((layer) => layer.name).concat(config.default));
    for (const layer of config.layers) {
        for (const allowed of layer.may) if (!known.has(allowed)) problems.push(`layers.json: ${layer.name} may import unknown layer ${allowed}`);
    }
    for (const file of sourceFiles(root)) {
        const layer = layerOf(relative(root, file), config);
        counts[layer] = (counts[layer] ?? 0) + 1;
        const may = new Set(config.layers.find((candidate) => candidate.name === layer)?.may ?? []);
        for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
            const specifier = match[1] ?? match[2] ?? match[3]!;
            const target = resolveImport(file, specifier, root);
            if (!target) continue;
            const targetLayer = layerOf(relative(root, target), config);
            if (targetLayer !== layer && !may.has(targetLayer)) {
                problems.push(`${relative(rootDirectory, file)}: ${layer} imports ${targetLayer} (${relative(root, target)})`);
            }
        }
    }
    return { problems, counts };
}

/**
 * An extracted package may import only itself, third-party packages, `#generated/*` (the host maps
 * those), and the `@hearthlog/*` packages it lists; never the app (`#lib`, `$lib`) and never a file
 * outside its own `src`.
 */
export function checkPackages(rootDirectory = ROOT, config: LayerConfig = JSON.parse(readFileSync(join(rootDirectory, "scripts", "layers.json"), "utf8"))): string[] {
    const problems: string[] = [];
    for (const [name, rule] of Object.entries(config.packages ?? {})) {
        const source = join(rootDirectory, "packages", name, "src");
        if (!existsSync(source)) continue;
        const own = `@hearthlog/${name}`;
        for (const file of sourceFiles(source)) {
            for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
                const specifier = match[1] ?? match[2] ?? match[3]!;
                const where = relative(rootDirectory, file);
                if (specifier.startsWith("#lib") || specifier.startsWith("$lib")) problems.push(`${where}: ${own} imports the app ("${specifier}")`);
                else if (specifier.startsWith(".")) {
                    const target = resolve(dirname(file), specifier);
                    const allowed = (rule.allowOutside ?? []).some((entry) => relative(rootDirectory, target).split(sep).join("/").replace(/\.(ts|js)$/, "") === entry);
                    if (target !== source && !target.startsWith(source + sep) && !allowed) problems.push(`${where}: ${own} reaches outside its src ("${specifier}")`);
                } else if (specifier.startsWith("@hearthlog/") && !specifier.startsWith(`${own}/`) && specifier !== own) {
                    const other = specifier.split("/").slice(0, 2).join("/");
                    if (!rule.may.includes(other.slice("@hearthlog/".length))) problems.push(`${where}: ${own} may not import ${other}`);
                }
            }
        }
    }
    return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { problems: layerProblems, counts } = checkLayers();
    const problems = [...layerProblems, ...checkPackages()];
    if (problems.length) {
        console.error(`Layering is broken:\n  - ${problems.join("\n  - ")}`);
        process.exitCode = 1;
    } else {
        console.log(`Layers hold: ${Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ")}.`);
    }
}
