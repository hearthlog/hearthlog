#!/usr/bin/env npx tsx
/**
 * Every name a module's Svelte files import from `@hearthlog/sdk/*` must be an
 * export of that SDK entry. `tsc` does not read `.svelte` files, so a missing
 * export would otherwise surface only in the production build.
 *
 * It collects the names, writes them as one virtual TypeScript file, and
 * type-checks that file inside the root program.
 *
 * Usage: pnpm check:sdk-exports
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostRoot } from "../root.js";

import ts from "typescript";

const ROOT = hostRoot();
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](@hearthlog\/sdk\/[a-z]+)["']/g;

function svelteFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
        if (name === "node_modules" || name.startsWith(".")) return [];
        const path = join(directory, name);
        return statSync(path).isDirectory() ? svelteFiles(path) : name.endsWith(".svelte") ? [path] : [];
    });
}

export function importedNames(root = ROOT): Map<string, Set<string>> {
    const names = new Map<string, Set<string>>();
    for (const module of existsSync(join(root, "modules")) ? readdirSync(join(root, "modules")) : []) {
        const source = join(root, "modules", module);
        if (!statSync(source).isDirectory()) continue;
        for (const file of [...svelteFiles(join(source, "src")), ...(statSync(join(source, "public"), { throwIfNoEntry: false }) ? svelteFiles(join(source, "public")) : [])]) {
            for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
                const set = names.get(match[2]!) ?? new Set<string>();
                for (const part of match[1]!.split(",")) {
                    const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
                    if (name) set.add(name);
                }
                names.set(match[2]!, set);
            }
        }
    }
    return names;
}

export function missingExports(root = ROOT): string[] {
    const names = importedNames(root);
    const virtualFile = join(root, "modules", "__sdk-exports.ts");
    const text = [...names].map(([entry, set]) => `import type { ${[...set].sort().join(", ")} } from '${entry}';`).join("\n");
    const configPath = join(root, "tsconfig.json");
    const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    if (!config) throw new Error("Cannot read tsconfig.json");
    const host = ts.createCompilerHost(config.options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (path) => path === virtualFile || fileExists(path);
    host.readFile = (path) => (path === virtualFile ? text : readFile(path));
    host.getSourceFile = (path, languageVersion, onError, shouldCreate) =>
        path === virtualFile ? ts.createSourceFile(path, text, languageVersion) : getSourceFile(path, languageVersion, onError, shouldCreate);
    const program = ts.createProgram([virtualFile], config.options, host);
    return ts.getPreEmitDiagnostics(program, program.getSourceFile(virtualFile))
        .filter((diagnostic) => [2305, 2724, 2307].includes(diagnostic.code))
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const problems = missingExports();
    if (problems.length) {
        console.error(`A module imports names the SDK does not export:\n  - ${problems.join("\n  - ")}`);
        process.exitCode = 1;
    } else {
        console.log("Every SDK import in module Svelte files resolves.");
    }
}
