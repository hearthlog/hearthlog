/**
 * Feature registry — the composition unit of the application.
 *
 * A FeatureDefinition owns a feature's page, its entities, and its commands;
 * Today widgets register themselves against the feature id. Tenants enable
 * features in tenants.json and everything else derives from here:
 *
 *   - route guard, navigation, and command menu entries
 *   - approved entities → local SQLite tables created for the tenant
 *   - projection/sync scoping and (phase 2) the ledger append allow-list
 *   - Entities-page grouping and PWA route prefetch
 *
 * This module must stay free of browser-only imports ($app/*, ~icons/*,
 * stores, runes): the codegen and deployment scripts import it from Node.
 */

import { ENTITY_DEFINITIONS, type EntityDefinition } from "../event/entity-definitions.js";
import { CORE_FEATURE_IDS, type CoreFeatureId } from "./core.js";
import { MODULE_FEATURES, type ModuleFeatureId } from "#generated/modules";

export { CORE_FEATURE_IDS };

/** Core features plus the features of the modules in `modules/*`. */
export type FeatureId = CoreFeatureId | ModuleFeatureId;

export type NavGroupName = "Money" | "Life" | "Tools";

export interface CommandShortcut {
    /** Stable id used by the command menu, e.g. "add-transaction". */
    id: string;
    label: string;
    subtitle: string;
    /** Space-separated search keywords for the command menu. */
    keywords: string;
    /** Query string appended to the feature path, e.g. "?newTransaction=1". */
    query?: string;
    /** Optional destination when an action lives inside another feature's page. */
    href?: string;
}

export interface PageMeta {
    /** Route prefix matched with startsWith. */
    path: string;
    label: string;
    subtitle: string;
    /** Space-separated search keywords for the command menu. */
    keywords: string;
    navGroup: NavGroupName;
    mobilePrimary?: boolean;
    mobileOrder?: number;
    /** Place among the destinations: lower first; none comes last. */
    navOrder?: number;
    /** Listed only behind the navigation's NSFW toggle; never a start section or a Recently place. */
    nsfw?: boolean;
}

export interface FeatureDefinition {
    id: FeatureId;
    /**
     * Page metadata. Optional so future features can own entities without
     * exposing a page; every current feature has one.
     */
    page?: PageMeta;
    /** Entity definitions owned by this feature (from entity-definitions.ts). */
    entities: readonly EntityDefinition[];
    /** Commands contributed to the command menu by this feature. */
    commands: CommandShortcut[];
}

const CORE_PAGE_META: Record<CoreFeatureId, PageMeta> = {
    calendar: {
        path: "/calendar",
        label: "Calendar",
        subtitle: "Workdays, weekends, and holidays",
        keywords: "date planning holiday workday",
        navGroup: "Life",
        mobilePrimary: true,
        mobileOrder: 3,
        navOrder: 40,
    },
};

const FEATURE_PAGE_META: Record<FeatureId, PageMeta> = {
    ...CORE_PAGE_META,
    ...Object.fromEntries(MODULE_FEATURES.map((feature) => [feature.id, {
        path: feature.path,
        label: feature.label,
        subtitle: feature.subtitle,
        keywords: feature.keywords,
        navGroup: feature.navGroup,
        ...(feature.mobilePrimary !== undefined ? { mobilePrimary: feature.mobilePrimary } : {}),
        ...(feature.mobileOrder !== undefined ? { mobileOrder: feature.mobileOrder } : {}),
        ...(feature.navOrder !== undefined ? { navOrder: feature.navOrder } : {}),
        ...(feature.nsfw ? { nsfw: true } : {}),
    } satisfies PageMeta])) as Record<ModuleFeatureId, PageMeta>,
};

/** Feature commands (create shortcuts surfaced by the command menu). */
const FEATURE_COMMANDS: Partial<Record<FeatureId, CommandShortcut[]>> = {
    ...Object.fromEntries(MODULE_FEATURES.filter((feature) => feature.shortcuts?.length).map((feature) => [feature.id, feature.shortcuts])),
};

function buildFeatures(): FeatureDefinition[] {
    return (Object.keys(FEATURE_PAGE_META) as FeatureId[]).map((id) => ({
        id,
        page: FEATURE_PAGE_META[id],
        entities: ENTITY_DEFINITIONS.filter(
            (definition) => definition.feature === id,
        ),
        commands: FEATURE_COMMANDS[id] ?? [],
    }));
}

export const FEATURES: readonly FeatureDefinition[] = buildFeatures();

/**
 * The Entities viewer is deliberately **not** a feature: its route is
 * governed by tenant policy rather than a feature page. When enabled, it
 * shows exactly the approved entities (plus dynamic ones the site created).
 * Both navigation and direct-route access are configurable per tenant
 * (`entitiesNavVisible`).
 */
export const ENTITIES_PATH = "/entities";
export const ENTITIES_META = {
    path: ENTITIES_PATH,
    label: "Entities",
    subtitle: "Raw records and types",
    keywords: "database records schema entity",
    navGroup: "Tools" as const,
};

/**
 * The Developer page is likewise registry-independent. Its navigation and
 * direct-route access, together with administrator capability, are configured
 * per tenant.
 */
export const DEVELOPER_PATH = "/developer";
export const DEVELOPER_META = {
    path: DEVELOPER_PATH,
    label: "Developer",
    subtitle: "Sync queue and diagnostics",
    keywords: "debug developer diagnostics sync logs",
} as const;

const FEATURES_BY_ID = new Map(FEATURES.map((feature) => [feature.id, feature]));

/** Longest-prefix match of a pathname against the feature routes. */
export function featureForPath(pathname: string): FeatureDefinition | null {
    let best: FeatureDefinition | null = null;
    for (const feature of FEATURES) {
        const path = feature.page?.path;
        if (!path) continue;
        if (
            (pathname === path || pathname.startsWith(`${path}/`)) &&
            (!best || path.length > (best.page?.path ?? "").length)
        ) {
            best = feature;
        }
    }
    return best;
}

export function featureById(id: FeatureId): FeatureDefinition {
    const feature = FEATURES_BY_ID.get(id);
    if (!feature) throw new Error(`Unknown feature id: ${id}`);
    return feature;
}

export function isFeatureId(id: string): id is FeatureId {
    return FEATURES_BY_ID.has(id as FeatureId);
}

// ============================================================================
// Entity approval (features → entities)
// ============================================================================

export interface ApprovedEntities {
    /** Projection table names (e.g. "calorie_entries"). */
    tables: ReadonlySet<string>;
    /** Event type prefixes (e.g. "CALORIE_ENTRY_"). */
    eventPrefixes: ReadonlySet<string>;
    /** Entity names (e.g. "calorie_entry"). */
    entityNames: ReadonlySet<string>;
}

/**
 * The approved entity set for a set of enabled features: the union of the
 * entities owned by those features. Drives local SQLite scoping, projection
 * filters, and (phase 2) the ledger append allow-list.
 */
export function approvedEntitiesForFeatures(
    features: ReadonlySet<string>,
): ApprovedEntities {
    const tables = new Set<string>();
    const eventPrefixes = new Set<string>();
    const entityNames = new Set<string>();
    for (const definition of ENTITY_DEFINITIONS) {
        if (!features.has(definition.feature)) continue;
        tables.add(definition.table);
        entityNames.add(definition.name);
        eventPrefixes.add(
            (definition.eventPrefix ?? definition.name.toUpperCase() + "_"),
        );
    }
    return { tables, eventPrefixes, entityNames };
}
