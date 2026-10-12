#!/usr/bin/env npx tsx
/**
 * Creating and exporting modules (plan, phases 7.4 and 7.6).
 *
 *   pnpm module:new    -- <name> [--feature <id>]   a working module from the template, in modules/<name>/
 *   pnpm module:export -- <name> --out <directory>  that module as a repository of its own
 *
 * A module made here composes without a single edit to the core: it needs only
 * its directory, and a tenant that lists its feature. The export is the layout
 * of a module repository: the module at the root with its own license and README, a `files` list that leaves out
 * the tests, provenance publishing, the platform as peers and dev dependencies, `pnpm test` (which is `hearthlog
 * check-module`: a site that enables the module builds, then its unit tests run), and the CI and tag-driven release workflows.
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MODULE_API_VERSION } from "@hearthlog/contracts";

import { PLATFORM_ROOT } from "../root.js";
import { REPOSITORY_ROOT } from "../tenants/tenant-config.js";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "module");
const NAME = /^[a-z][a-z0-9-]{1,30}$/;

export interface ScaffoldOptions {
    name: string;
    /** The feature id a tenant lists; the module's name by default. Persisted in tenants, so never renamed. */
    feature?: string;
    publisher?: string;
}

function title(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");
}

/** The files of a minimal, working module: one feature, one page, no data. */
export function moduleTemplate(options: ScaffoldOptions): Record<string, string> {
    const { name } = options;
    if (!NAME.test(name)) throw new Error(`"${name}" must be lowercase letters, digits and hyphens`);
    const feature = options.feature ?? name;
    if (!NAME.test(feature)) throw new Error(`The feature id "${feature}" must be lowercase letters, digits and hyphens`);
    const publisher = options.publisher ?? "org.example";
    const label = title(name);
    return {
        "package.json": `${JSON.stringify({
            name: `@hearthlog/module-${name}`,
            version: "0.1.0",
            license: "AGPL-3.0-only",
            private: true,
            type: "module",
            exports: {
                "./hearthlog.module.json": "./hearthlog.module.json",
                "./pages/*.js": "./src/pages/*.ts",
                "./pages/*.svelte": "./src/pages/*.svelte",
            },
            dependencies: { "@hearthlog/sdk": "workspace:*" },
        }, null, 2)}\n`,
        "hearthlog.module.json": `${JSON.stringify({
            manifestVersion: 1,
            id: `${publisher}.${name}`,
            package: `@hearthlog/module-${name}`,
            version: "0.1.0",
            compatibility: { moduleApi: MODULE_API_VERSION },
            features: [{
                id: feature,
                path: `/${feature}`,
                label,
                subtitle: `${label} for your workspace`,
                keywords: `${name} ${feature}`,
                navGroup: "Tools",
                icon: "puzzle-outline",
            }],
            routes: [{ path: `/${feature}`, page: "./src/pages/home.svelte", load: "./src/pages/home.ts" }],
        }, null, 2)}\n`,
        "src/pages/home.ts": `import { deferLocalPage } from "@hearthlog/sdk/runtime";

export const load = ({ url }: { url: URL }) => deferLocalPage(url, {}, async () => ({}));
`,
        "src/pages/home.svelte": `<script lang="ts">
    import { PageHeader } from "@hearthlog/sdk/ui";
    import { tenant } from "@hearthlog/sdk/runtime";
</script>

<svelte:head><title>${label} | {tenant.title}</title></svelte:head>
<div class="stor-page w-full p-2.5 sm:p-3">
    <PageHeader title="${label}" />
    <section class="stor-panel p-[var(--stor-panel-padding)]">
        <p class="text-sm text-[var(--stor-muted-text)]">${label} is installed.</p>
    </section>
</div>
`,
        "README.md": `# ${label}

A module for the Hearthlog platform. It reaches the app only through \`@hearthlog/sdk\`; the
\`ModuleManifest\` type in \`@hearthlog/contracts\` documents what a module may declare (pages, entities,
repositories, gateway code, startup code, attention badges), and \`pnpm check:modules\` enforces the
boundary.
`,
    };
}

export function scaffoldModule(modulesDirectory: string, options: ScaffoldOptions): string {
    const directory = join(modulesDirectory, options.name);
    if (existsSync(directory)) throw new Error(`${relative(REPOSITORY_ROOT, directory)} already exists`);
    for (const [file, content] of Object.entries(moduleTemplate(options))) {
        const path = join(directory, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
    return directory;
}

/**
 * A module as a repository of its own: its files at the root, `workspace:`
 * references turned into ranges, a license, and a README that says what is
 * still missing (CI and publishing, which wait for the platform packages).
 */
export function exportModule(modulesDirectory: string, name: string, out: string, platformRange = ">=0.1.0 <0.2.0"): string[] {
    const source = join(modulesDirectory, name);
    if (!existsSync(join(source, "hearthlog.module.json"))) throw new Error(`modules/${name} is not a module`);
    if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
    cpSync(source, out, { recursive: true, filter: (path) => !/(^|\/)(node_modules|\.git|dist)(\/|$)/.test(path) });
    const packagePath = join(out, "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
        name?: string; private?: boolean; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; license?: string;
    };
    const platform = Object.keys(manifest.dependencies ?? {}).filter((dependency) => dependency.startsWith("@hearthlog/"));
    // A platform package the sources import must be declared, or the repository cannot resolve it.
    const imported = new Set<string>();
    for (const file of listFiles(join(out, "src")).filter((candidate) => /\.(ts|svelte)$/.test(candidate))) {
        for (const match of readFileSync(file, "utf8").matchAll(/from ["'](@hearthlog\/[a-z-]+)[/"']/g)) imported.add(match[1]!);
    }
    const undeclared = [...imported].filter((dependency) => !platform.includes(dependency) && dependency !== manifest.name && !dependency.startsWith("@hearthlog/module-"));
    if (undeclared.length > 0) throw new Error(`modules/${name} imports ${undeclared.join(", ")} without declaring it in its package.json`);
    manifest.peerDependencies = { ...(manifest.peerDependencies ?? {}), ...Object.fromEntries(platform.map((dependency) => [dependency, platformRange])) };
    for (const dependency of platform) delete manifest.dependencies![dependency];
    if (manifest.dependencies && Object.keys(manifest.dependencies).length === 0) delete manifest.dependencies;
    delete manifest.private;
    manifest.license = "AGPL-3.0-only";
    // The repository the module leaves: its pnpm and test tooling, and its license.
    const root = JSON.parse(readFileSync(join(PLATFORM_ROOT, "package.json"), "utf8")) as { devDependencies?: Record<string, string>; packageManager?: string };
    const publishable = {
        ...manifest,
        repository: { type: "git", url: `git+https://github.com/hearthlog/hearthlog-module-${name}.git` },
        publishConfig: { access: "public", provenance: true },
        files: ["src", ...(existsSync(join(out, "public")) ? ["public"] : []), "hearthlog.module.json", "!**/*.test.ts"],
        packageManager: root.packageManager,
        scripts: { test: "hearthlog check-module" },
        // The platform the module is developed and tested against; the peer range says which releases it accepts.
        devDependencies: {
            ...Object.fromEntries([...platform, "@hearthlog/tooling"].sort().map((dependency) => [dependency, platformRange])),
            vitest: root.devDependencies?.vitest ?? "^4.1.11",
        },
    };
    writeFileSync(packagePath, `${JSON.stringify(publishable, null, 2)}\n`);
    mkdirSync(join(out, ".github", "workflows"), { recursive: true });
    copyFileSync(join(TEMPLATE, "gitignore.tmpl"), join(out, ".gitignore"));
    copyFileSync(join(TEMPLATE, "gitleaks.toml.tmpl"), join(out, ".gitleaks.toml"));
    // vitest's esbuild needs its install script; pnpm 10 asks for it by name.
    writeFileSync(join(out, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - esbuild\n");
    copyFileSync(join(TEMPLATE, "ci.yml.tmpl"), join(out, ".github", "workflows", "ci.yml"));
    copyFileSync(join(TEMPLATE, "release.yml.tmpl"), join(out, ".github", "workflows", "release.yml"));
    cpSync(join(PLATFORM_ROOT, "LICENSE"), join(out, "LICENSE"));
    const readme = join(out, "README.md");
    const existing = existsSync(readme) ? readFileSync(readme, "utf8").trimEnd() : `# ${title(name)}`;
    writeFileSync(readme, `${existing}\n\n## Status\n\nIt installs against \`@hearthlog/sdk\` ${platformRange}.\n\n\`\`\`bash\npnpm install\npnpm test   # generates a site that enables this module, installs it, builds it, then runs the unit tests\n\`\`\`\n\nRelease: set \`version\` in \`package.json\`, commit, and push the tag \`v<version>\`; the release workflow publishes with provenance after approval.\n`);
    return listFiles(out).map((file) => relative(out, file)).sort();
}

function listFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2).filter((argument) => argument !== "--");
    const [command, name] = args;
    const value = (flag: string) => {
        const index = args.indexOf(flag);
        return index === -1 ? undefined : args[index + 1];
    };
    const modules = join(REPOSITORY_ROOT, "modules");
    if (command === "new" && name) {
        const directory = scaffoldModule(modules, { name, feature: value("--feature") });
        console.log(`Created ${relative(REPOSITORY_ROOT, directory)}. Next:\n  1. pnpm install\n  2. pnpm generate:modules && pnpm generate:entities\n  3. add "${value("--feature") ?? name}" to a site's features in tenants.json, then pnpm compose`);
    } else if (command === "export" && name && value("--out")) {
        const files = exportModule(modules, name, resolve(value("--out")!));
        console.log(`Exported ${files.length} file(s) of modules/${name} to ${resolve(value("--out")!)}`);
    } else {
        console.error("Usage: pnpm module:new -- <name> [--feature <id>]\n       pnpm module:export -- <name> --out <directory>");
        process.exit(1);
    }
}
