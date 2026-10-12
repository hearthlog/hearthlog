/**
 * Meta-Entity Event Types
 * 
 * Event types for managing entity type definitions at runtime.
 * These events are stored in the Ledger and enable dynamic entity creation.
 */

import type { EntityCalendarSource } from '@hearthlog/contracts/calendar/config';

// ============================================================================
// Field Definition Types
// ============================================================================

/**
 * Field type for dynamic entity fields
 */
export type DynamicFieldType = 'string' | 'number' | 'boolean' | 'reference' | 'datetime';

/**
 * Definition for a field in a dynamic entity
 */
export interface DynamicFieldDefinition {
    /** Database column name (snake_case) */
    name: string;
    /** Field data type */
    type: DynamicFieldType;
    /** Event payload key (camelCase). Defaults to camelCase version of name */
    payloadKey: string;
    /** Whether the field is required in ADD events */
    required?: boolean;
    /** Default value for the field */
    default?: string | number | boolean | null;

    // Validation constraints
    /** Regex pattern for string validation */
    pattern?: string;
    /** Minimum value for numbers */
    min?: number;
    /** Maximum value for numbers */
    max?: number;
    /** Minimum length for strings */
    minLength?: number;
    /** Maximum length for strings */
    maxLength?: number;
    /** Allowed values (picklist/enum) */
    enum?: string[];

    // Reference configuration
    /** Target entity name for reference fields */
    referenceTo?: string;
}

// ============================================================================
// Event Payload Types
// ============================================================================

/**
 * Payload for ENTITY_TYPE_DEFINED event
 */
export interface DefineEntityTypePayload {
    /** Entity type ID (UUID) */
    id: string;
    /** Entity name (lowercase, e.g., 'project') */
    name: string;
    /** Human-readable display name (e.g., 'Project') */
    displayName: string;
    /** Database table name (e.g., 'projects') */
    tableName: string;
    /** Field definitions */
    fields: DynamicFieldDefinition[];
    /** Optional calendar dates exposed by this entity. */
    calendar?: EntityCalendarSource[];
}

/**
 * Payload for ENTITY_TYPE_UPDATED event
 */
export interface UpdateEntityTypePayload {
    /** Entity type ID */
    id: string;
    /** Updated display name */
    displayName?: string;
    /** Fields to add (additive only) */
    addFields?: DynamicFieldDefinition[];
    /** Replace the calendar dates; null clears them. */
    calendar?: EntityCalendarSource[] | null;
    /** Field updates (non-breaking changes only) */
    updateFields?: Array<{
        name: string;
        displayName?: string;
        default?: string | number | boolean | null;
        // Validation can be loosened but not tightened
        pattern?: string;
        min?: number;
        max?: number;
        minLength?: number;
        maxLength?: number;
        enum?: string[];
    }>;
}

/**
 * Payload for ENTITY_TYPE_ARCHIVED event
 */
export interface ArchiveEntityTypePayload {
    /** Entity type ID */
    id: string;
}

// ============================================================================
// Event Types
// ============================================================================

export interface EntityTypeDefinedEvent {
    id: string;
    type: 'ENTITY_TYPE_DEFINED';
    timestamp: number;
    payload: DefineEntityTypePayload;
}

export interface EntityTypeUpdatedEvent {
    id: string;
    type: 'ENTITY_TYPE_UPDATED';
    timestamp: number;
    payload: UpdateEntityTypePayload;
}

export interface EntityTypeArchivedEvent {
    id: string;
    type: 'ENTITY_TYPE_ARCHIVED';
    timestamp: number;
    payload: ArchiveEntityTypePayload;
}

/**
 * Union type for all meta-entity events
 */
export type MetaEntityEvent =
    | EntityTypeDefinedEvent
    | EntityTypeUpdatedEvent
    | EntityTypeArchivedEvent;

// ============================================================================
// Type Guards
// ============================================================================

export function isMetaEntityEvent(event: { type: string }): event is MetaEntityEvent {
    return (
        event.type === 'ENTITY_TYPE_DEFINED' ||
        event.type === 'ENTITY_TYPE_UPDATED' ||
        event.type === 'ENTITY_TYPE_ARCHIVED'
    );
}

export function isEntityTypeDefinedEvent(event: { type: string }): event is EntityTypeDefinedEvent {
    return event.type === 'ENTITY_TYPE_DEFINED';
}

export function isEntityTypeUpdatedEvent(event: { type: string }): event is EntityTypeUpdatedEvent {
    return event.type === 'ENTITY_TYPE_UPDATED';
}

export function isEntityTypeArchivedEvent(event: { type: string }): event is EntityTypeArchivedEvent {
    return event.type === 'ENTITY_TYPE_ARCHIVED';
}
