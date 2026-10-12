/**
 * Entity Registry
 * 
 * Hybrid registry supporting both static (compile-time) and dynamic (runtime) entities.
 * Static entities from ENTITY_DEFINITIONS always take precedence over dynamic ones.
 */

import { ENTITY_DEFINITIONS, getEventPrefix } from '@hearthlog/contracts/event/entity-definitions';
import type { EntityCalendarSource } from '@hearthlog/contracts/calendar/config';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { PROJECTION_CONFIGS, type EntityProjectionConfig } from './projection-builder.js';

export interface EntityRegistryEntry {
    /** Projection configuration for SQL generation */
    projection: EntityProjectionConfig;
    /** Event type prefix for type guards (e.g., 'CALENDAR_EVENT_') */
    eventPrefix: string;
    /** Database table name */
    table: string;
    /** Whether this is a dynamic (runtime-defined) entity */
    isDynamic?: boolean;
    /** Calendar dates the entity exposes (dynamic entities only today). */
    calendar?: EntityCalendarSource[];
}

// ============================================================================
// Static Registry (Compile-time entities)
// ============================================================================

/**
 * Static registry of the entities this tenant is approved for (feature
 * ownership in entity-definitions.ts; approval derived from the tenant's
 * enabled features). Events for non-approved entities are stored in
 * raw_events but never materialized.
 */
const staticRegistry: Record<string, EntityRegistryEntry> = Object.fromEntries(
    ENTITY_DEFINITIONS
        .filter(def => tenant.approvedEntities.entityNames.has(def.name))
        .map(def => [
            def.name,
            {
                projection: PROJECTION_CONFIGS[def.name],
                eventPrefix: getEventPrefix(def),
                table: def.table,
                isDynamic: false,
            }
        ])
);

// ============================================================================
// Dynamic Registry (Runtime entities)
// ============================================================================

/**
 * Dynamic registry of entities defined at runtime.
 * Mutable - can be updated as new entity types are created.
 */
let dynamicRegistry: Record<string, EntityRegistryEntry> = {};

/**
 * Register a dynamic entity type.
 * If a static entity with the same name exists, the static one takes precedence.
 */
export function registerDynamicEntity(name: string, entry: EntityRegistryEntry): void {
    if (staticRegistry[name]) {
        console.warn(`[Registry] Dynamic entity "${name}" shadowed by static entity`);
        return;
    }
    dynamicRegistry[name] = { ...entry, isDynamic: true };
    console.log(`[Registry] Registered dynamic entity: ${name}`);
}

/**
 * Unregister a dynamic entity type.
 */
export function unregisterDynamicEntity(name: string): void {
    delete dynamicRegistry[name];
    console.log(`[Registry] Unregistered dynamic entity: ${name}`);
}

/**
 * Clear all dynamic entities (used during rebuild).
 */
export function clearDynamicRegistry(): void {
    dynamicRegistry = {};
    console.log('[Registry] Cleared dynamic registry');
}

/**
 * Get names of all dynamic entities.
 */
export function getDynamicEntityNames(): string[] {
    return Object.keys(dynamicRegistry);
}

// ============================================================================
// Unified Access (Backwards Compatible)
// ============================================================================

/**
 * Get the combined registry of static + dynamic entities.
 * Static entities take precedence over dynamic ones.
 */
export function getEntityRegistry(): Record<string, EntityRegistryEntry> {
    return { ...dynamicRegistry, ...staticRegistry };
}

/**
 * Legacy: Direct access to registry for backwards compatibility.
 * Prefer using getEntityRegistry() for future code.
 */
export const entityRegistry: Record<string, EntityRegistryEntry> = new Proxy({} as Record<string, EntityRegistryEntry>, {
    get(_target, prop: string) {
        return getEntityRegistry()[prop];
    },
    has(_target, prop: string) {
        return prop in getEntityRegistry();
    },
    ownKeys() {
        return Object.keys(getEntityRegistry());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
        const registry = getEntityRegistry();
        if (prop in registry) {
            return { configurable: true, enumerable: true, value: registry[prop] };
        }
        return undefined;
    }
});

/**
 * Get all registered entity configurations (static + dynamic).
 */
export function getAllEntityConfigs(): EntityProjectionConfig[] {
    return Object.values(getEntityRegistry()).map(e => e.projection);
}

/**
 * Get all registered table names (static + dynamic).
 */
export function getAllEntityTables(): string[] {
    return Object.values(getEntityRegistry()).map(e => e.table);
}

/**
 * Get only static entity names.
 */
export function getStaticEntityNames(): string[] {
    return Object.keys(staticRegistry);
}

/**
 * Check if an entity is static (compile-time defined).
 */
export function isStaticEntity(name: string): boolean {
    return name in staticRegistry;
}

