/**
 * What every site's frontend Worker config shares. `wrangler-config.ts` adds the site: its identity, variables, and
 * the bindings its modules declare. The compatibility date is the Workers runtime the gateway code is tested against,
 * so a tenant moves it by upgrading `@hearthlog/tooling`.
 */

export interface WranglerBase {
    compatibility_date: string;
    compatibility_flags: string[];
    assets: {
        binding: string;
        not_found_handling: string;
        /** The core's API paths; a site's modules add theirs (see `siteWorkerFirst`). `/api/ledger` stays first. */
        run_worker_first: string[];
    };
    observability: { enabled: boolean };
    placement: { mode: string };
    images: { binding: string };
    ai: { binding: string };
    /** Service ingest is limited per Access client id; the namespace id only has to be unique in the account. */
    ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
    /** The daily sweep of the public Gallery copies, for the site that owns the bucket. */
    triggers: { crons: string[] };
}

export const WRANGLER_BASE: WranglerBase = {
    compatibility_date: "2026-07-21",
    compatibility_flags: ["assets_navigation_has_no_effect"],
    assets: {
        binding: "ASSETS",
        not_found_handling: "none",
        run_worker_first: [
            "/api/ledger",
            "/api/ledger/*",
            "/api/session",
            "/api/ai/v1",
            "/api/ai/v1/*",
            "/api/calendar-feeds/v1",
            "/api/calendar-feeds/v1/*",
            "/api/integrations/v1",
            "/api/integrations/v1/*",
        ],
    },
    observability: { enabled: true },
    placement: { mode: "smart" },
    images: { binding: "IMAGES" },
    ai: { binding: "AI" },
    ratelimits: [{ name: "INTEGRATIONS_LIMITER", namespace_id: "21001", simple: { limit: 30, period: 60 } }],
    triggers: { crons: ["23 3 * * *"] },
};
