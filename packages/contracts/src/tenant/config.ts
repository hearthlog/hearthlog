/**
 * Runtime access to the tenant configuration for the browser app.
 *
 * The concrete values live in `./generated.ts`, which is produced by
 * `packages/tooling/src/generate/generate-tenant.ts` from `tenants.json` before every dev server
 * start and build. All feature gating and branding in the UI derives from
 * this module.
 */

import type { AiCapability } from "../ai/capabilities.js";
import type { FeatureId } from "../features/registry.js";
import { IMPLICIT_FEATURE_IDS } from "../features/core.js";
import {
    approvedEntitiesForFeatures,
    type ApprovedEntities,
} from "../features/registry.js";
// Keep this import on the dedicated alias: tenant builds replace it
// with an isolated generated module. A relative/#lib import would resolve the
// committed Hearthlog module and silently give every tenant Hearthlog's feature set.
import { TENANT, TENANT_ID } from "$tenant/generated";
import { brandColor, brandTileSvg } from "./brand";
import { themeVariablesFor } from "./theme";

/** Shape of the generated tenant module (see packages/tooling/src/generate/generate-tenant.ts). */
export interface TenantModule {
    id: string;
    ledgerAppName: string;
    title: string;
    home: string;
    features: readonly FeatureId[];
    /** AI decision capabilities the site enables; absent means none. */
    ai?: readonly AiCapability[];
    developerNavVisible: boolean;
    entitiesNavVisible: boolean;
    dynamicEntities: boolean;
    theme: { accent?: string };
    admin: boolean;
    hostname: string;
    /** The external food catalog's origin; empty when the operator configured none. */
    kalApiOrigin: string;
}

export interface TenantConfig {
    id: string;
    /** Application name registered in the Ledger AppRegistry. */
    ledgerAppName: string;
    title: string;
    /** Landing route used by the layout guard; always an enabled feature. */
    home: string;
    /** Enabled feature ids; `today` is always present. */
    features: ReadonlySet<FeatureId>;
    /** Enabled AI decision capabilities; the UI hides a suggestion whose capability is off. */
    ai: ReadonlySet<AiCapability>;
    /** Whether the Developer page appears in navigation and command menu. */
    developerNavVisible: boolean;
    /** Whether the Entities viewer appears in navigation and command menu. */
    entitiesNavVisible: boolean;
    /** Whether the site may create dynamic entity types (meta-entities). */
    dynamicEntities: boolean;
    /** Entities approved for this tenant, derived from enabled features. */
    approvedEntities: ApprovedEntities;
    /**
     * Resolved palette embedded on the document root by tenant generation.
     */
    themeVariables: Readonly<Record<string, string>>;
    /** Data-URI SVG favicon: the brand mark on the tenant colour. */
    faviconHref: string;
    /**
     * Whether this site's Worker holds LEDGER_ADMIN_TOKEN. The UI treats this
     * as a hint only; administrator capability is confirmed at runtime by
     * LedgerAdmin's own session probe.
     */
    admin: boolean;
    hostname: string;
    kalApiOrigin: string;
}

function brandFavicon(accent: string | undefined, action: string): string {
    const svg = brandTileSvg({
        background: brandColor(accent, action),
        fill: "#fbf9fa",
        scale: 0.7,
        radius: 112,
    });
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function createTenantConfig(module: TenantModule): TenantConfig {
    const themeVariables = themeVariablesFor(module.theme.accent);
    return {
        id: module.id,
        ledgerAppName: module.ledgerAppName,
        title: module.title,
        home: module.home,
        features: new Set<FeatureId>([...module.features, ...IMPLICIT_FEATURE_IDS]),
        ai: new Set(module.ai ?? []),
        developerNavVisible: module.developerNavVisible,
        entitiesNavVisible: module.entitiesNavVisible,
        dynamicEntities: module.dynamicEntities,
        approvedEntities: approvedEntitiesForFeatures(
            new Set<string>([...module.features, ...IMPLICIT_FEATURE_IDS]),
        ),
        themeVariables,
        faviconHref: brandFavicon(
            module.theme.accent,
            themeVariables["--stor-action"],
        ),
        admin: module.admin,
        hostname: module.hostname,
        kalApiOrigin: module.kalApiOrigin,
    };
}

export const tenant: TenantConfig = createTenantConfig(TENANT);

export function isFeatureEnabled(featureId: FeatureId): boolean {
    return tenant.features.has(featureId);
}

export function isAiCapabilityEnabled(capability: AiCapability): boolean {
    return tenant.ai.has(capability);
}

export { TENANT_ID };
