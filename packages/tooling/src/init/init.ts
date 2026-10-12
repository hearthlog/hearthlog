#!/usr/bin/env npx tsx
/**
 * `hearthlog init <dir> --id <id> [--title <title>] [--modules <list>] [--workspace] [--check] [--force]`
 *
 * Render `templates/tenant/` into a new site: the package.json, the Vite and TypeScript configuration, a
 * `tenants.json` with placeholder infrastructure (it makes the site load and cannot be deployed), the site's
 * `tenant.json`, its module lock, the committed `.generated/package.json`, and the pnpm settings the install needs (the
 * build scripts to allow and the patch to `sqlocal`, which does not travel with a dependency). The modules are named by package
 * (`@hearthlog/module-calc`), by short name (`calc`), or `none`; their features become the site's features.
 * `--workspace` writes the `@hearthlog` dependencies as `workspace:*` (a site inside a workspace); otherwise
 * they are `^<version of this package>`. `--check` writes nothing and fails when the files on disk differ
 * from what init would write, so the committed examples cannot drift from the template; `--force` rewrites
 * existing files (how an example is brought back in line).
 *
 * Nothing here reads generated files: init is how a site gets started, before `hearthlog build` has run.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModules, type LoadedModule } from "../compose/compose-modules.js";
import { lockFor, renderModuleLock } from "../tenants/lock-file.js";

const TOOLING = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE = join(TOOLING, "templates", "tenant");

/** The @hearthlog packages every site depends on; the modules it uses are added to them. */
const CORE_PACKAGES = ["cloudflare", "contracts", "ledger", "runtime", "sdk", "shell", "tooling", "ui"] as const;

export interface InitOptions {
    directory: string;
    id: string;
    title?: string;
    /** Package names or short names of the modules the site ships. */
    modules?: readonly string[];
    workspace?: boolean;
    /** The installed modules to choose from; defaults to the ones the current host has. */
    available?: readonly LoadedModule[];
}

const SITE_ID = /^[a-z][a-z0-9-]{0,38}$/;

function render(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        if (!(key in values)) throw new Error(`The template names {{${key}}}, which init does not know`);
        return values[key]!;
    });
}

/** A tenant's deploy workflow (`templates/tenant/github-workflows/deploy.yml.tmpl`); `paths` limits the pushes that run it. */
export function renderWorkflow(id: string, paths: readonly string[] = []): string {
    const pushPaths = paths.length > 0 ? `\n    paths:\n${paths.map((path) => `      - "${path}"`).join("\n")}` : "";
    return render(readFileSync(join(TEMPLATE, "github-workflows", "deploy.yml.tmpl"), "utf8"), { id, idUpper: id.toUpperCase().replace(/-/g, "_"), pushPaths });
}

function toolingPackage(): { version: string; peerDependencies?: Record<string, string> } {
    return JSON.parse(readFileSync(join(TOOLING, "package.json"), "utf8")) as { version: string; peerDependencies?: Record<string, string> };
}

function chooseModules(names: readonly string[], available: readonly LoadedModule[]): LoadedModule[] {
    return names.map((name) => {
        const found = available.find(({ manifest }) => manifest.package === name || manifest.package === `@hearthlog/module-${name}`);
        if (!found) throw new Error(`No installed module is called "${name}" (installed: ${available.map(({ manifest }) => manifest.package).join(", ") || "none"})`);
        return found;
    });
}

/** Every file init writes, as [path relative to the site, content]. */
export function renderSite(options: InitOptions): Array<[string, string]> {
    const { id, workspace = false } = options;
    if (!SITE_ID.test(id)) throw new Error(`The site id "${id}" must be lowercase letters, digits, and hyphens, starting with a letter`);
    const title = options.title ?? id;
    const modules = chooseModules(options.modules ?? [], options.available ?? loadModules());
    const features = [...new Set(modules.flatMap(({ manifest }) => manifest.features.map((feature) => feature.id)))].sort();
    const tooling = toolingPackage();
    const own = workspace ? "workspace:*" : `^${tooling.version}`;

    const manifest = JSON.parse(readFileSync(join(TEMPLATE, "package.json.tmpl"), "utf8")) as Record<string, unknown>;
    const dependencies: Record<string, string> = Object.fromEntries([
        ...CORE_PACKAGES.map((name) => [`@hearthlog/${name}`, own]),
        // A module is released on its own version, not on the platform's.
        ...modules.map(({ manifest: { package: name }, directory }) => [name, workspace ? own : `^${(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string }).version}`]),
        ["@hearthlog/generated", "link:.generated"],
    ].sort(([a], [b]) => a!.localeCompare(b!)));
    const devDependencies = Object.fromEntries(Object.entries(tooling.peerDependencies ?? {}).filter(([name]) => !name.startsWith("@hearthlog/")).sort(([a], [b]) => a.localeCompare(b)));
    const packageJson = { name: id, ...manifest, dependencies, devDependencies };

    const values = { id, title, features: JSON.stringify(features) };
    const template = (name: string) => readFileSync(join(TEMPLATE, name), "utf8");
    return [
        ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
        ["vite.config.ts", template("vite.config.ts.tmpl")],
        ["tsconfig.json", template("tsconfig.json.tmpl")],
        ["tenants.json", template("tenants.json.tmpl")],
        [`tenants/${id}/tenant.json`, render(template("tenants/__id__/tenant.json.tmpl"), values)],
        [`tenants/${id}/modules.lock.json`, renderModuleLock(lockFor(modules, features))],
        [".generated/package.json", template("generated-package.json.tmpl")],
        ["pnpm-workspace.yaml", template("pnpm-workspace.yaml.tmpl")],
        ["patches/sqlocal@0.18.0.patch", template("patches/sqlocal@0.18.0.patch")],
        [".github/workflows/deploy.yml", renderWorkflow(id)],
        [".gitignore", template("gitignore.tmpl")],
        ["README.md", render(template("README.md.tmpl"), values)],
    ];
}

/** The files whose content differs from what init would write. */
export async function initProblems(options: InitOptions): Promise<string[]> {
    const problems: string[] = [];
    for (const [path, content] of renderSite(options)) {
        const current = await readFile(join(options.directory, path), "utf8").catch(() => null);
        if (current === null) problems.push(`${path} is missing`);
        else if (current !== content) problems.push(`${path} differs from the template`);
    }
    return problems;
}

export async function init(options: InitOptions & { force?: boolean }): Promise<string[]> {
    const written: string[] = [];
    for (const [path, content] of renderSite(options)) {
        const target = join(options.directory, path);
        if (existsSync(target) && !options.force) throw new Error(`${path} already exists in ${options.directory}; init does not overwrite`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        written.push(path);
    }
    return written;
}

function parse(argv: string[]): { options: InitOptions & { force: boolean }; check: boolean } {
    const value = (flag: string) => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const directory = argv.find((argument, index) => !argument.startsWith("--") && !["--id", "--title", "--modules"].includes(argv[index - 1] ?? ""));
    const id = value("--id");
    if (!directory || !id) throw new Error("Usage: hearthlog init <dir> --id <id> [--title <title>] [--modules <list|none>] [--workspace] [--check] [--force]");
    const modules = value("--modules");
    return {
        options: {
            directory: resolve(directory),
            id,
            title: value("--title"),
            modules: modules === undefined || modules === "none" ? [] : modules.split(",").map((name) => name.trim()).filter(Boolean),
            workspace: argv.includes("--workspace"),
            force: argv.includes("--force"),
        } as InitOptions & { force: boolean },
        check: argv.includes("--check"),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const { options, check } = parse(process.argv.slice(2));
        if (check) {
            const problems = await initProblems(options);
            if (problems.length > 0) throw new Error(`${options.directory} no longer matches the template:\n  - ${problems.join("\n  - ")}`);
            console.log(`${options.directory} matches the template.`);
        } else {
            const written = await init(options);
            console.log(`Wrote ${written.length} file(s) to ${options.directory}. Next: pnpm install && pnpm build`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
