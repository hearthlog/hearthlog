/**
 * Names the core reserves, so no module can claim them. Pure data: the module
 * composer reads it before any generated module file exists.
 */

/** Features whose code still lives in this app rather than in a module. */
export const CORE_FEATURE_IDS = ['calendar'] as const;

/**
 * Features every tenant has without listing them: Calendar is a platform
 * surface that modules feed through the date sources they declare, not
 * something a tenant installs. A `calendar` entry in `tenants.json` is
 * accepted and ignored.
 */
export const IMPLICIT_FEATURE_IDS = ['calendar'] as const;

export type CoreFeatureId = (typeof CORE_FEATURE_IDS)[number];

/** Refresh keys of the core's own route loaders. */
export const CORE_REFRESH_KEYS = [
    'app:history',
    'app:developer',
    'app:entities',
    'app:entity-types',
    'app:calendar',
] as const;

/** API prefixes the gateway Worker serves itself (`packages/cloudflare/src/gateway.ts`); no module may claim them. */
export const CORE_API_PREFIXES = [
    '/api/ledger',
    '/api/session',
    '/api/ai',
    '/api/calendar-feeds',
    '/api/log-forks',
    '/api/integrations',
] as const;
