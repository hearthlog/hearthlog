#!/usr/bin/env npx tsx
/**
 * Emit the deployed site ids as a JSON array (for the CI build matrix).
 * Sites on their own stack (tenants/<id>/deployment.json) are left out.
 *
 * Usage: pnpm list:sites
 */

import { loadTenantConfig, sharedSites } from "../tenants/tenant-config.js";

const { sites } = await loadTenantConfig();
// A site on its own stack is deployed by its operator with that stack's own
// Ledger administrator token, which CI does not hold.
const scoped = sharedSites(sites);
console.log(JSON.stringify(scoped.map((site) => site.id)));
