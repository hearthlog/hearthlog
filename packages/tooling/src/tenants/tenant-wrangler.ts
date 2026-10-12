/**
 * Shared wrangler invocation for one tenant's frontend Worker.
 *
 * Every site's wrangler config is generated from tenants.json on demand (`.generated/sites/<id>/wrangler.jsonc`).
 */

import { spawnSync } from "node:child_process";

import { loadTenantConfig, REPOSITORY_ROOT, TenantConfigError } from "./tenant-config.js";
import {
    generateTenantWranglerConfigs,
    resolveFrontendWranglerTarget,
} from "./wrangler-config.js";

export async function runTenantWrangler(
    siteId: string,
    args: string[],
): Promise<void> {
    await generateTenantWranglerConfigs(siteId);
    const { sites } = await loadTenantConfig();
    if (!sites.some((site) => site.id === siteId)) {
        throw new TenantConfigError(
            `Unknown site id "${siteId}" (known: ${sites.map((site) => site.id).join(", ")})`,
        );
    }

    const target = await resolveFrontendWranglerTarget(siteId);
    const tail = target.envKey === null ? [] : ["--env", target.envKey];
    const result = spawnSync(
        "pnpm",
        ["exec", "wrangler", ...args, "--config", target.config, ...tail],
        { cwd: REPOSITORY_ROOT, stdio: "inherit" },
    );
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
