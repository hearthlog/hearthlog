/**
 * Resolves entity definitions (static and dynamic) into usable calendar
 * sources. Shared by the SQL repository on the client and the event fold in
 * the Worker so both agree on which dates exist and which configs are valid.
 *
 * Pure module: no Svelte, no database, no `#lib/db/index.js` imports.
 */

import {
    calendarSourceKey,
    normalizeCalendarSources,
    parseCalendarConfig,
    validateCalendarConfig,
    type CalendarFieldLike,
    type EntityCalendarSource,
} from './config';
import { getPayloadKey, type EntityDefinition } from '../event/entity-definitions.js';

export interface CalendarSourceDefinition {
    /** Stable key used in the source preference, ICS UIDs, and feed registrations. */
    key: string;
    entityName: string;
    label: string;
    dynamic: boolean;
    /** Projection table name (client SQL path). */
    table: string;
    config: EntityCalendarSource;
    fields: readonly CalendarFieldLike[];
    /** Column name -> event payload key, for the Worker's event fold. */
    payloadKeys: Readonly<Record<string, string>>;
    /** Event type prefix, e.g. `CALENDAR_EVENT_`. */
    eventPrefix: string;
}

/** Row shape of `entity_type_definitions` needed for resolution. */
export interface DynamicEntityDefinitionLike {
    name: string;
    table_name: string;
    fields_json: string;
    calendar_json: string | null;
}

export interface CalendarSourceResolutionOptions {
    /** Static entities the tenant is approved for. */
    approvedEntityNames: ReadonlySet<string>;
    /** Tables available for parent joins. */
    approvedTables: ReadonlySet<string>;
    /** Whether runtime-defined entity types participate. */
    dynamicEnabled: boolean;
}

/**
 * Resolve every valid calendar source. Invalid configs and duplicate keys are
 * skipped (static sources win over dynamic ones) so a bad definition degrades
 * to "not on the calendar" instead of breaking the page or a feed.
 */
export function calendarSourceDefinitions(
    staticDefinitions: readonly EntityDefinition[],
    dynamicDefinitions: readonly DynamicEntityDefinitionLike[],
    options: CalendarSourceResolutionOptions,
): CalendarSourceDefinition[] {
    const resolved: CalendarSourceDefinition[] = [];
    const seen = new Set<string>();

    for (const definition of staticDefinitions) {
        if (!options.approvedEntityNames.has(definition.name)) continue;
        const payloadKeys: Record<string, string> = {};
        for (const field of definition.fields) {
            payloadKeys[field.name] = getPayloadKey(field);
        }
        for (const config of normalizeCalendarSources(definition.calendar)) {
            if (!pushSource(resolved, seen, {
                entityName: definition.name,
                dynamic: false,
                table: definition.table,
                config,
                fields: definition.fields,
                payloadKeys,
                eventPrefix: definition.eventPrefix ?? definition.name.toUpperCase() + '_',
                parentTables: options.approvedTables,
            })) {
                continue;
            }
        }
    }

    if (options.dynamicEnabled) {
        for (const record of dynamicDefinitions) {
            const configs = parseCalendarConfig(record.calendar_json);
            if (configs.length === 0) continue;
            const fields = parseFieldDefinitions(record);
            if (fields.length === 0) continue;
            const payloadKeys: Record<string, string> = {};
            for (const field of fields) {
                payloadKeys[field.name] = field.payloadKey;
            }
            for (const config of configs) {
                pushSource(resolved, seen, {
                    entityName: record.name,
                    dynamic: true,
                    table: record.table_name,
                    config,
                    fields,
                    payloadKeys,
                    eventPrefix: `${record.name.toUpperCase()}_`,
                    // Dynamic definitions cannot declare parent joins.
                    parentTables: new Set<string>(),
                });
            }
        }
    }

    return resolved;
}

interface PushSourceInput {
    entityName: string;
    dynamic: boolean;
    table: string;
    config: EntityCalendarSource;
    fields: readonly CalendarFieldLike[];
    payloadKeys: Readonly<Record<string, string>>;
    eventPrefix: string;
    parentTables: ReadonlySet<string>;
}

function pushSource(
    resolved: CalendarSourceDefinition[],
    seen: Set<string>,
    input: PushSourceInput,
): boolean {
    const errors = validateCalendarConfig(
        input.entityName,
        input.config,
        input.fields,
        { parentTables: input.parentTables },
    );
    if (errors.length > 0) {
        console.warn(
            `[Calendar] Ignoring invalid calendar source "${input.entityName}": ${errors[0]}`,
        );
        return false;
    }
    const key = calendarSourceKey(input.entityName, input.config);
    if (seen.has(key)) {
        console.warn(`[Calendar] Ignoring duplicate calendar source key "${key}"`);
        return false;
    }
    seen.add(key);
    resolved.push({
        key,
        entityName: input.entityName,
        label: input.config.label,
        dynamic: input.dynamic,
        table: input.table,
        config: input.config,
        fields: input.fields,
        payloadKeys: input.payloadKeys,
        eventPrefix: input.eventPrefix,
    });
    return true;
}

interface DynamicFieldLike extends CalendarFieldLike {
    payloadKey?: string;
}

function parseFieldDefinitions(
    record: DynamicEntityDefinitionLike,
): Array<CalendarFieldLike & { payloadKey: string }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(record.fields_json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const fields: Array<CalendarFieldLike & { payloadKey: string }> = [];
    for (const entry of parsed as DynamicFieldLike[]) {
        if (
            !entry ||
            typeof entry.name !== 'string' ||
            typeof entry.type !== 'string'
        ) {
            continue;
        }
        fields.push({
            name: entry.name,
            type: entry.type,
            payloadKey:
                typeof entry.payloadKey === 'string' && entry.payloadKey
                    ? entry.payloadKey
                    : entry.name,
        });
    }
    return fields;
}
