#!/usr/bin/env npx tsx
/**
 * Validate one site's frontend Worker deployment without uploading.
 *
 * Usage: pnpm frontend:worker:dry-run:tenant -- --site bravo
 */

import { runTenantWrangler } from "../tenants/tenant-wrangler.js";

const args = process.argv.slice(2);
const siteIndex = args.indexOf("--site");
const siteId = siteIndex !== -1 ? args[siteIndex + 1]?.trim() : undefined;
if (!siteId) {
    console.error("Usage: tsx packages/tooling/src/deploy/frontend-dry-run.ts --site <site-id>");
    process.exit(1);
}

await runTenantWrangler(siteId, ["versions", "upload", "--dry-run"]);