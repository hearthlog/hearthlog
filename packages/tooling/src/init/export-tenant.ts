#!/usr/bin/env npx tsx
/**
 * `hearthlog export <id> --out <dir>` (root script `pnpm tenant:export -- <id> --out <dir>`)
 *
 * Write the repository of one tenant that owns its stack: what `hearthlog init` renders (package.json, Vite and
 * TypeScript configuration, pnpm settings, workflow, `.gitignore`) plus the tenant's own `tenants/<id>/`. The shared
 * account values the site read from this repository's `tenants.json` are written into the exported `deployment.json`
 * (an own-stack site needs no `tenants.json`, and the shared block names other tenants' resources). Nothing from
 * `.wrangler/` is copied: no token files, no receipts, no device settings. Like `module:export`, this creates no
 * repository and touches no remote.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModules, type LoadedModule } from "../compose/compose-modules.js";
import { hostRoot } from "../root.js";
import { renderSite } from "./init.js";

export interface ExportOptions {
    /** The host directory (it holds `tenants/<id>/` and, for a shared block, `tenants.json`). */
    root: string;
    id: string;
    out: string;
    available?: readonly LoadedModule[];
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** The deployment file with the shared block's account values filled in where the site has none of its own. */
export function exportedDeployment(deployment: Record<string, unknown>, shared: Record<string, unknown> | undefined): Record<string, unknown> {
    const result: Record<string, unknown> = { ...deployment };
    const take = (key: string, value: unknown) => {
        if (result[key] === undefined && value !== undefined) result[key] = value;
    };
    take("workersDevDomain", shared?.workersDevDomain);
    if (typeof shared?.accessTeamDomain === "string") take("authentication", { provider: "cloudflare-access", teamDomain: shared.accessTeamDomain });
    for (const key of ["ledgerAdminEmail", "invoiceRendererOrigin", "kalApiOrigin", "accessSessionDuration", "accessGlobalSessionDuration"]) take(key, shared?.[key]);
    for (const key of ["workersDevDomain", "authentication", "ledgerAdminEmail"]) {
        if (result[key] === undefined) throw new Error(`tenants/<id>/deployment.json has no ${key} and the shared block has none to give`);
    }
    return result;
}

/** The site's definition with the shared `defaults` it relied on written in, so the repository needs no `tenants.json`. */
export function exportedTenant(tenant: Record<string, unknown>, defaults: Record<string, unknown> | undefined): Record<string, unknown> {
    const result: Record<string, unknown> = { ...tenant };
    for (const [key, value] of Object.entries(defaults ?? {})) {
        if (result[key] === undefined) result[key] = value;
    }
    return result;
}

function readme(title: string, id: string): string {
    return `# ${title}

The Hearthlog site \`${id}\`, on its own stack. \`tenants/${id}/\` holds what it enables and the stack it owns
(\`tenant.json\`, \`deployment.json\`, \`modules.lock.json\`, \`static/\`); everything else the app needs is written by
\`pnpm build:generated\` into \`.generated/\`.

\`\`\`bash
pnpm install
pnpm dev     # builds the generated files, then starts Vite
pnpm build   # a static build in build/
pnpm hearthlog plan --site ${id}   # read-only: resources, steps, problems
\`\`\`

Deploys run from \`.github/workflows/deploy.yml\` in the protected \`${id}\` environment. To run \`hearthlog\` against the
stack from this machine (plan with the real account, \`apply\`), copy the site's \`.wrangler/tenants/${id}/\` token files
into this checkout's \`.wrangler/\`; they are never exported or committed.
`;
}

export async function exportTenant(options: ExportOptions): Promise<string[]> {
    const { root, id } = options;
    const out = resolve(options.out);
    const tenantDirectory = join(root, "tenants", id);
    if (!existsSync(join(tenantDirectory, "tenant.json"))) throw new Error(`There is no site "${id}" in ${root}`);
    if (!existsSync(join(tenantDirectory, "deployment.json"))) throw new Error(`${id} is on the shared stack (no deployment.json): move it to its own stack first`);
    if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);

    const sharedFile = join(root, "tenants.json");
    const sharedBlock = existsSync(sharedFile) ? readJson(sharedFile) : {};
    const shared = sharedBlock.infrastructure as Record<string, unknown> | undefined;
    const deployment = exportedDeployment(readJson(join(tenantDirectory, "deployment.json")), shared);
    const tenant = exportedTenant(readJson(join(tenantDirectory, "tenant.json")), sharedBlock.defaults as Record<string, unknown> | undefined);
    const title = typeof tenant.title === "string" ? tenant.title : id;
    const lock = readJson(join(tenantDirectory, "modules.lock.json")) as { modules: Array<{ package: string }> };

    const written: string[] = [];
    const put = async (path: string, content: string) => {
        const target = join(out, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        written.push(path);
    };
    for (const [path, content] of renderSite({ directory: out, id, title, modules: lock.modules.map((module) => module.package), available: options.available ?? loadModules() })) {
        // The tenant's own files replace the starter's, and an own-stack site needs no tenants.json.
        if (path === "tenants.json" || path.startsWith(`tenants/${id}/`)) continue;
        await put(path, path === "README.md" ? readme(title, id) : content);
    }
    await mkdir(join(out, "tenants", id), { recursive: true });
    await cp(tenantDirectory, join(out, "tenants", id), { recursive: true, filter: (source) => !/(deployment|tenant)\.json$|\.DS_Store$/.test(source) });
    await put(`tenants/${id}/tenant.json`, `${JSON.stringify(tenant, null, 2)}\n`);
    await put(`tenants/${id}/deployment.json`, `${JSON.stringify(deployment, null, 2)}\n`);
    return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const argv = process.argv.slice(2);
        const flag = argv.indexOf("--out");
        const out = flag >= 0 ? argv[flag + 1] : undefined;
        const id = argv.find((argument, index) => !argument.startsWith("--") && index !== flag + 1);
        if (!id || !out) throw new Error("Usage: hearthlog export <id> --out <dir>");
        const written = await exportTenant({ root: hostRoot(), id, out });
        console.log(`Wrote the repository of ${id} to ${resolve(out)} (${written.length} files plus tenants/${id}/). Next: cd there, pnpm install, pnpm build.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
