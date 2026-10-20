#!/usr/bin/env npx tsx
/**
 * `hearthlog apple:types [<module directory>] [--check]`
 *
 * Writes the Swift types for a module's native contract (`native.contract`) to its `native.swiftTypes`, so a native
 * app calls the module's functions with checked arguments and results. `--check` writes nothing and fails when the
 * file is missing or stale; `hearthlog check-module` runs it. The directory defaults to the current one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadModuleAt } from "../compose/compose-modules.js";
import { swiftTypes, type ContractShape } from "./swift-types.js";

export interface GeneratedSwiftTypes {
    /** Absolute path of `native.swiftTypes`. */
    path: string;
    source: string;
}

/** The Swift for the module in `directory`, or null when it declares no native contract or no `swiftTypes` file. */
export async function generateSwiftTypes(directory: string): Promise<GeneratedSwiftTypes | null> {
    const { manifest } = loadModuleAt(resolve(directory));
    if (!manifest.native?.swiftTypes) return null;
    const loaded = (await import(pathToFileURL(join(resolve(directory), manifest.native.contract)).href)) as { default?: ContractShape };
    if (!loaded.default?.namespace || !loaded.default.queries) {
        throw new Error(`${manifest.id}: ${manifest.native.contract} must export its defineNativeContract(...) by default`);
    }
    return {
        path: join(resolve(directory), manifest.native.swiftTypes),
        source: swiftTypes(loaded.default, { moduleId: manifest.id, contractFile: manifest.native.contract.replace(/^\.\//, "") }),
    };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const directory = argv.find((argument) => !argument.startsWith("--")) ?? ".";
    const generated = await generateSwiftTypes(directory);
    if (!generated) {
        console.log("This module declares no native.swiftTypes; nothing to write.");
        return;
    }
    const current = existsSync(generated.path) ? readFileSync(generated.path, "utf8") : null;
    if (argv.includes("--check")) {
        if (current !== generated.source) {
            throw new Error(`${generated.path} is ${current === null ? "missing" : "stale"}: run hearthlog apple:types to write it from the native contract.`);
        }
        console.log("The Swift types match the native contract.");
        return;
    }
    if (current === generated.source) {
        console.log(`${generated.path} is current.`);
        return;
    }
    mkdirSync(dirname(generated.path), { recursive: true });
    writeFileSync(generated.path, generated.source);
    console.log(`Wrote ${generated.path}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
