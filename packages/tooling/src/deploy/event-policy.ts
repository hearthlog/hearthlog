/**
 * The event policy a site's Ledger application enforces: the core's events and
 * those of the modules the site ships, runtime entity types only when the site
 * enables them, and rejection (not just a log line) of anything else. The
 * Ledger stores it with the application (`PUT /admin/v1/apps/<id>/policy`).
 */

import { loadModules, modulesForFeatures } from "../compose/compose-modules.js";
import type { ResolvedSite } from "../tenants/tenant-config.js";

export interface EventPolicy {
    contracts: string[];
    dynamicEvents: boolean;
    validation: "enforce";
}

export function siteEventPolicy(site: Pick<ResolvedSite, "features" | "dynamicEntities">): EventPolicy {
    return {
        contracts: modulesForFeatures(loadModules(), site.features).map(({ manifest }) => manifest.id).sort(),
        dynamicEvents: site.dynamicEntities,
        validation: "enforce",
    };
}
