/**
 * `hearthlog gallery-public:build [--site <id>]`: build a stack's public Gallery Worker.
 *
 * The Gallery module ships the Worker's source (`public/` in its package). The browser bundle is built first, then the
 * Worker, which renders the same Svelte components on the server and carries that bundle to serve it. Both go into
 * `dist/` beside the stack's generated `wrangler.jsonc` (`.generated/shared/gallery-public/` or the site's own).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModules } from "../compose/compose-modules.js";
import { generateHostConfigs, hostWorkerDirectory } from "../tenants/host-configs.js";
import { loadTenantConfig } from "../tenants/tenant-config.js";

const ASSETS_MODULE = "\0gallery-public-client-assets";

export async function buildGalleryPublic(stack: string): Promise<string> {
    await generateHostConfigs(stack);
    const output = hostWorkerDirectory(stack, "gallery-public");
    // A site without the Gallery has no public Gallery Worker to build.
    if (!existsSync(join(output, "wrangler.jsonc"))) {
        console.log(`The ${stack} stack has no public Gallery Worker.`);
        return output;
    }
    const module = loadModules().find(({ manifest }) => manifest.publicWorker?.name === "gallery");
    if (!module) throw new Error("No installed module has a public Gallery Worker");
    const source = join(module.directory, "public");
    const clientOut = join(output, "dist", "client");

    // Loaded here, not at the top: only a site that builds the Worker needs them.
    const { build } = await import("vite");
    const { svelte } = await import("@sveltejs/vite-plugin-svelte");
    const { default: Icons } = await import("unplugin-icons/vite");

    /** Replaces the empty `client-assets` module with the built browser files. */
    const clientAssets = {
        name: "gallery-public-client-assets",
        enforce: "pre" as const,
        resolveId(id: string, importer?: string) {
            return id === "./client-assets" && importer?.startsWith(source) ? ASSETS_MODULE : undefined;
        },
        load(id: string) {
            if (id !== ASSETS_MODULE) return undefined;
            const manifest = JSON.parse(readFileSync(join(clientOut, ".vite/manifest.json"), "utf8")) as Record<string, { file: string; css?: string[] }>;
            const entry = manifest["app/client.ts"];
            if (!entry) throw new Error("Build the public Gallery client first.");
            const asset = (file: string, type: string) => ({ path: `/_app/${file.split("/").pop()}`, body: readFileSync(join(clientOut, file), "utf8"), type });
            return `export const clientAssets = ${JSON.stringify({
                script: asset(entry.file, "text/javascript; charset=utf-8"),
                styles: (entry.css ?? []).map((file) => asset(file, "text/css; charset=utf-8")),
            })};`;
        },
    };

    const common = {
        root: source,
        configFile: false as const,
        publicDir: false as const,
        logLevel: "warn" as const,
    };
    await build({
        ...common,
        plugins: [svelte({ configFile: false }), Icons({ compiler: "svelte" })],
        build: {
            outDir: clientOut,
            emptyOutDir: true,
            manifest: true,
            target: "es2022",
            rolldownOptions: {
                input: "app/client.ts",
                output: { entryFileNames: "assets/app-[hash].js", assetFileNames: "assets/app-[hash][extname]" },
            },
        },
    });
    await build({
        ...common,
        plugins: [svelte({ configFile: false }), Icons({ compiler: "svelte" }), clientAssets],
        // Resolve Svelte's server runtime (its `worker` export), never the browser one.
        ssr: { target: "webworker", noExternal: true, resolve: { conditions: ["worker", "workerd", "svelte", "module", "import", "default"] } },
        build: {
            ssr: "index.ts",
            outDir: join(output, "dist", "worker"),
            emptyOutDir: true,
            target: "es2022",
            minify: true,
            // Workers provide AsyncLocalStorage under the `nodejs_als` flag.
            rolldownOptions: { external: ["node:async_hooks"], output: { entryFileNames: "index.js", format: "es" } },
        },
    });
    return output;
}

/** The stack a command works on: `--site <id>` when that site has its own stack, else the shared one. */
export async function stackFor(argv: string[]): Promise<string> {
    const flag = argv.indexOf("--site");
    const id = (flag >= 0 ? argv[flag + 1] : undefined) ?? "";
    if (!id) return "shared";
    const { sites } = await loadTenantConfig(undefined, { only: id });
    const site = sites.find((candidate) => candidate.id === id);
    if (!site) throw new Error(`Unknown site id "${id}"`);
    return site.deployment ? id : "shared";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    stackFor(process.argv.slice(2))
        .then(buildGalleryPublic)
        .then((output) => console.log(`Built the public Gallery Worker in ${output}`))
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
