/**
 * Entity Definitions
 *
 * Single source of truth for all entity configurations.
 * Adding a new entity only requires adding it to ENTITY_DEFINITIONS.
 *
 * The registry and projection configs are auto-generated from these definitions.
 */

// ============================================================================
// Type Definitions
// ============================================================================

import type { FeatureId } from "../features/registry.js";
import type { EntityCalendarSource } from "../calendar/config.js";
import { MODULE_ENTITY_DEFINITIONS } from "#generated/modules";

/**
 * Field type mapping for entity fields
 */
export type FieldType = "string" | "number" | "boolean" | "datetime";

/**
 * Configuration for an entity field
 */
export interface EntityFieldDefinition {
    /** Database column name (snake_case) */
    name: string;
    /** TypeScript/payload type */
    type: FieldType;
    /** Event payload key (camelCase). Defaults to camelCase version of name if not specified */
    payloadKey?: string;
    /** Whether the field is required in ADD events */
    required?: boolean;
    /** New optional event fields must remain compatible with older producers. */
    optionalInPayload?: boolean;
    /** Default value for the field. Use SQL expressions for dynamic defaults like "date('now')". For booleans, use 0 or 1. */
    default?: string | number | null;
}

/**
 * Configuration for a database index on an entity projection table.
 * Column order is significant and supports composite indexes.
 */
export interface EntityIndexDefinition {
    /** Stable, globally unique SQLite index name */
    name: string;
    /** Ordered database columns, including automatic columns such as tenant_id and log_id */
    columns: string[];
    /** Whether to create a UNIQUE index */
    unique?: boolean;
}

/**
 * Complete definition for an entity type
 */
export interface EntityDefinition {
    /** Unique entity name (lowercase, e.g., 'calendar_event') */
    name: string;
    /**
     * The feature that owns this entity. A tenant's approved entity set is
     * the union of entities of its enabled features (see
     * packages/contracts/src/features/registry.ts); local SQLite tables are only created
     * for approved entities.
     */
    feature: FeatureId;
    /** Human-readable label used by generic entity tooling */
    displayName?: string;
    /** Database table name (plural, e.g., 'assets', 'goals') */
    table: string;
    /**
     * Event type prefix (uppercase with trailing underscore, e.g., 'CALENDAR_EVENT_').
     * Derived from name.toUpperCase() + '_' if not specified.
     */
    eventPrefix?: string;
    /** Entity fields (excluding 'id', 'created_at', 'updated_at' which are automatic) */
    fields: EntityFieldDefinition[];
    /**
     * Calendar sources derived from this entity's fields. One config per date
     * field; see packages/contracts/src/calendar/config.ts for the shape and semantics.
     */
    calendar?: EntityCalendarSource | EntityCalendarSource[];
    /** Database indexes for the generated projection table */
    indexes?: EntityIndexDefinition[];
    /**
     * How Log history names a record that has no title: its main value, for
     * example "Weight 81.2 kg" from `{ noun: 'Weight', key: 'weight', unit: ' kg' }`.
     */
    summary?: { noun: string; key: string; unit: string };
    /**
     * The field that names an immutable file version stored outside the Ledger (Gallery's photo
     * originals). The Ledger records, per log, every accepted add or update that names one, so a
     * private file gateway can ask whether a log may read that exact version, and so a fork keeps
     * only the references that existed at its fork point. The entity must carry a `string` field of
     * that name; its id is the entity's own id.
     */
    fileReference?: { versionField: string };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts snake_case to camelCase
 */
function toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Gets the event prefix for an entity definition
 */
export function getEventPrefix(def: EntityDefinition): string {
    return def.eventPrefix || def.name.toUpperCase() + "_";
}

/**
 * Gets the event types for an entity (ADDED, UPDATED, REMOVED)
 */
export function getEventTypes(def: EntityDefinition): [string, string, string] {
    const prefix = getEventPrefix(def);
    return [`${prefix}ADDED`, `${prefix}UPDATED`, `${prefix}REMOVED`];
}

/**
 * Gets the payload key for a field (uses payloadKey if specified, otherwise converts name to camelCase)
 */
export function getPayloadKey(field: EntityFieldDefinition): string {
    return field.payloadKey || toCamelCase(field.name);
}

// ============================================================================
// Entity Definitions
// ============================================================================

/**
 * All entity definitions in the application.
 */
const CORE_ENTITY_DEFINITIONS: EntityDefinition[] = [
    {
        name: "calendar_event",
        feature: "calendar",
        displayName: "Calendar Event",
        table: "calendar_events",
        fields: [
            {
                name: "title",
                type: "string",
                payloadKey: "title",
                required: true,
            },
            {
                name: "event_date",
                type: "datetime",
                payloadKey: "eventDate",
                required: true,
            },
            {
                name: "start_time",
                type: "string",
                payloadKey: "startTime",
                default: "",
            },
            { name: "notes", type: "string", payloadKey: "notes", default: "" },
            {
                name: "pinned",
                type: "boolean",
                payloadKey: "pinned",
                default: 0,
            },
        ],
        calendar: {
            key: "event",
            dateField: "event_date",
            timeField: "start_time",
            titleField: "title",
            pinnedField: "pinned",
            label: "Event",
            presentation: { icon: "calendar-blank-outline", tone: "accent", href: null, rank: 0 },
            group: { id: "events", label: "Events", icon: "calendar-blank-outline" },
        },
        indexes: [
            {
                name: "idx_calendar_events_scope_date",
                columns: ["tenant_id", "log_id", "event_date", "start_time"],
            },
            {
                name: "idx_calendar_events_scope_pinned_date",
                columns: [
                    "tenant_id",
                    "log_id",
                    "pinned",
                    "event_date",
                    "start_time",
                ],
            },
        ],
    },
];

/** Core entities, then those of the modules in `modules/*` (their persisted names never change). */
export const ENTITY_DEFINITIONS: EntityDefinition[] = [...CORE_ENTITY_DEFINITIONS, ...MODULE_ENTITY_DEFINITIONS];

/**
 * Get an entity definition by name
 */
export function getEntityDefinition(
    name: string,
): EntityDefinition | undefined {
    return ENTITY_DEFINITIONS.find((def) => def.name === name);
}

/**
 * Get all entity names
 */
export function getAllEntityNames(): string[] {
    return ENTITY_DEFINITIONS.map((def) => def.name);
}
