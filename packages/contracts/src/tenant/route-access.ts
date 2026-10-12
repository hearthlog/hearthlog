import {
    DEVELOPER_PATH,
    ENTITIES_PATH,
    featureForPath,
} from "../features/registry.js";
import { getEntityDefinition } from "../event/entity-definitions.js";
import { moduleRouteAllowed } from "../features/navigation.js";
import { MODULE_REDIRECTS, MODULE_ROUTES } from "#generated/modules";
import type { TenantConfig } from "./config";

export type TenantRouteConfig = Pick<
    TenantConfig,
    | "features"
    | "home"
    | "developerNavVisible"
    | "entitiesNavVisible"
    | "dynamicEntities"
    | "approvedEntities"
>;

/**
 * Return the safe landing route when a pathname is outside this tenant's
 * contract. This is used by the root load as an access guard, not merely by
 * navigation, so direct URLs and stale PWA links receive the same treatment.
 */
export function tenantRouteRedirect(
    pathname: string,
    config: TenantRouteConfig,
): string | null {
    const feature = featureForPath(pathname);
    if (feature && !config.features.has(feature.id)) return config.home;

    // A module page outside every feature path (Health's Day) states which features it needs.
    const route = MODULE_ROUTES.find((candidate) => pathname === candidate.path || pathname.startsWith(`${candidate.path}/`));
    if (route && !moduleRouteAllowed(route.path, config.features)) return config.home;

    if (
        pathname === DEVELOPER_PATH ||
        pathname.startsWith(`${DEVELOPER_PATH}/`)
    ) {
        return config.developerNavVisible ? null : config.home;
    }

    if (
        pathname === ENTITIES_PATH ||
        pathname.startsWith(`${ENTITIES_PATH}/`)
    ) {
        if (!config.entitiesNavVisible) return config.home;

        const entityName = pathname
            .slice(`${ENTITIES_PATH}/`.length)
            .split("/", 1)[0];
        if (!entityName) return null;

        let decodedEntityName: string;
        try {
            decodedEntityName = decodeURIComponent(entityName);
        } catch {
            return config.home;
        }
        if (
            getEntityDefinition(decodedEntityName) &&
            !config.approvedEntities.entityNames.has(decodedEntityName)
        ) {
            return config.home;
        }
        if (!getEntityDefinition(decodedEntityName) && !config.dynamicEntities) {
            return config.home;
        }
    }

    return null;
}

/**
 * Old addresses a module moved (such as Health's `/bmi?section=activity`).
 * They resolve before the feature guard, so a moved bookmark reaches its new
 * page even when the old page's feature is off.
 */
export function moduleRedirect(url: URL, features: ReadonlySet<string>): string | null {
    for (const redirect of MODULE_REDIRECTS) {
        if (url.pathname !== redirect.path || !features.has(redirect.feature)) continue;
        const query = Object.entries(redirect.query ?? {});
        if (!query.every(([key, value]) => url.searchParams.get(key) === value)) continue;
        const target = new URL(url);
        target.pathname = redirect.to;
        for (const [key] of query) target.searchParams.delete(key);
        return `${target.pathname}${target.search}${target.hash}`;
    }
    return null;
}
