import { buildNavigation } from '@hearthlog/contracts/features/navigation';
import { DEVELOPER_PATH, ENTITIES_PATH, featureForPath } from '@hearthlog/contracts/features/registry';
import type { TenantConfig } from '@hearthlog/contracts/tenant/config';

function storageKey(tenantId: string): string {
    return `stor:last-section:${tenantId}`;
}

/** Keep only the feature's entry page, never a date, filter, or drawer. */
export function sectionForPath(pathname: string, tenant: TenantConfig): string | null {
    if (pathname === DEVELOPER_PATH && tenant.developerNavVisible) return DEVELOPER_PATH;
    if (pathname === ENTITIES_PATH || pathname.startsWith(`${ENTITIES_PATH}/`)) {
        return tenant.entitiesNavVisible ? ENTITIES_PATH : null;
    }

    const feature = featureForPath(pathname);
    if (!feature || !tenant.features.has(feature.id)) return null;
    return feature.page?.path ?? null;
}

export function defaultSection(tenant: TenantConfig): string {
    const configured = sectionForPath(tenant.home, tenant);
    if (configured) return configured;
    return buildNavigation(tenant).destinations[0]?.path ?? DEVELOPER_PATH;
}

export function startSection(tenant: TenantConfig, storage: Pick<Storage, 'getItem'> | null): string {
    try {
        const saved = storage?.getItem(storageKey(tenant.id));
        if (saved) {
            const section = sectionForPath(saved, tenant);
            if (section) return section;
        }
    } catch {
        // A blocked browser store still has a usable start route.
    }
    return defaultSection(tenant);
}

export function startTarget(_url: URL, tenant: TenantConfig, storage: Pick<Storage, 'getItem'> | null): string {
    return startSection(tenant, storage);
}

export function rememberSection(
    url: { pathname: string },
    tenant: TenantConfig,
    storage: Pick<Storage, 'setItem'> | null,
): void {
    const section = sectionForPath(url.pathname, tenant);
    if (!section) return;
    try {
        storage?.setItem(storageKey(tenant.id), section);
    } catch {
        // Navigation remains usable when browser storage is unavailable.
    }
}
