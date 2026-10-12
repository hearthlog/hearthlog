import {
    ENTITY_DEFINITIONS,
    getEventTypes,
    getPayloadKey,
} from '@hearthlog/contracts/event/entity-definitions';
import type { ExtendedAppEvent } from '../event/types.js';
import type { EntityDefinition } from '@hearthlog/contracts/event/entity-definitions';
import { tenant } from '@hearthlog/contracts/tenant/config';
import {
    sanitizeCalendarSource,
    validateCalendarConfig,
    type CalendarFieldLike,
    type EntityCalendarSource,
} from '@hearthlog/contracts/calendar/config';

export class CommandValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CommandValidationError';
    }
}

type KnownEvent = {
    definition: EntityDefinition;
    kind: 'added' | 'updated' | 'removed';
};

const eventDefinitions = new Map<string, KnownEvent>(
    ENTITY_DEFINITIONS.flatMap((definition) => {
        const [added, updated, removed] = getEventTypes(definition);
        return [
            [added, { definition, kind: 'added' as const }],
            [updated, { definition, kind: 'updated' as const }],
            [removed, { definition, kind: 'removed' as const }],
        ];
    }),
);

export function validateCommandEvents(events: ExtendedAppEvent[]): void {
    if (events.length === 0) {
        throw new CommandValidationError('A command must contain at least one event');
    }

    const ids = new Set<string>();
    for (const event of events) {
        if (!event.id?.trim()) throw new CommandValidationError('Event ID is required');
        if (ids.has(event.id)) {
            throw new CommandValidationError(`Duplicate event ID in command: ${event.id}`);
        }
        ids.add(event.id);

        if (!event.type?.trim()) throw new CommandValidationError('Event type is required');
        if (!Number.isFinite(event.timestamp)) {
            throw new CommandValidationError(`Event ${event.id} has an invalid timestamp`);
        }
        if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
            throw new CommandValidationError(`Event ${event.id} must have an object payload`);
        }

        validateKnownEvent(event);
    }
}

function validateKnownEvent(event: ExtendedAppEvent): void {
    if (['EVENT_TOMBSTONED', 'EVENTS_EXCISED', 'WORKSPACE_RESTORED'].includes(event.type)) {
        throw new CommandValidationError(`Event ${event.id}: history removal and restore commands are retired`);
    }

    if (
        event.type === 'ENTITY_TYPE_DEFINED' ||
        event.type === 'ENTITY_TYPE_UPDATED' ||
        event.type === 'ENTITY_TYPE_ARCHIVED'
    ) {
        if (!tenant.dynamicEntities) {
            throw new CommandValidationError(
                `Event ${event.id}: this site is not allowed to manage dynamic entity types`,
            );
        }
        if (event.type !== 'ENTITY_TYPE_DEFINED') {
            requireString(event, 'id');
            sanitizeCalendarPayload(event);
            return;
        }
        requireString(event, 'id');
        requireString(event, 'name');
        requireString(event, 'displayName');
        requireString(event, 'tableName');
        // SAFETY: payload was checked to be a non-array object by validateCommandEvents.
        const payload = event.payload as unknown as Record<string, unknown>;
        if (!Array.isArray(payload.fields)) {
            throw new CommandValidationError(`Event ${event.id} requires fields`);
        }
        const sources = sanitizeCalendarPayload(event);
        if (sources.length > 0) {
            const fields: CalendarFieldLike[] = (payload.fields as unknown[])
                .filter(
                    (field): field is { name: string; type: string } =>
                        typeof field === 'object' &&
                        field !== null &&
                        typeof (field as { name?: unknown }).name === 'string' &&
                        typeof (field as { type?: unknown }).type === 'string',
                )
                .map((field) => ({ name: field.name, type: field.type }));
            const errors = validateCalendarConfig(
                payload.name as string,
                sources,
                fields,
                { parentTables: new Set<string>() },
            );
            if (errors.length > 0) {
                throw new CommandValidationError(
                    `Event ${event.id}: ${errors[0]}`,
                );
            }
        }
        return;
    }

    const known = eventDefinitions.get(event.type);
    if (!known) {
        if (/_(ADDED|UPDATED|REMOVED)$/.test(event.type)) requireString(event, 'id');
        return;
    }

    // Feature scoping (defense in depth — the owning pages are already
    // gated): commands may never append events for entities the tenant is
    // not approved for. Dynamic (runtime-defined) entity events are not in
    // this map and pass through; their creation is gated separately.
    const approvalError = eventApprovalError(
        event.type,
        tenant.features as ReadonlySet<string>,
    );
    if (approvalError) {
        throw new CommandValidationError(`Event ${event.id}: ${approvalError}`);
    }

    requireString(event, 'id');
    if (known.kind !== 'added') return;

    for (const field of known.definition.fields.filter((item) => item.required)) {
        const key = getPayloadKey(field);
        // SAFETY: payload was checked to be a non-array object by validateCommandEvents.
        const value = (event.payload as unknown as Record<string, unknown>)[key];
        if (value === undefined || value === null || value === '') {
            throw new CommandValidationError(`Event ${event.id} requires ${key}`);
        }
        if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
            throw new CommandValidationError(`Event ${event.id} requires a finite ${key}`);
        }
    }
}

/**
 * Returns an error message when the event type belongs to an entity the
 * given feature set does not approve; null when allowed (meta events and
 * dynamic entity events are not feature-scoped here).
 */
export function eventApprovalError(
    eventType: string,
    features: ReadonlySet<string>,
): string | null {
    const known = eventDefinitions.get(eventType);
    if (!known) return null;
    if (!features.has(known.definition.feature)) {
        return (
            `the entity "${known.definition.table}" belongs to the ` +
            `"${known.definition.feature}" feature, which is not enabled for this site`
        );
    }
    return null;
}

/**
 * Validate the optional `calendar` payload of a meta event. Returns the
 * sanitized sources; an omitted or null value means "no calendar dates".
 * Semantic field checks run in the DEFINED branch where fields are present.
 */
function sanitizeCalendarPayload(event: ExtendedAppEvent): EntityCalendarSource[] {
    // SAFETY: payload was checked to be a non-array object by validateCommandEvents.
    const payload = event.payload as unknown as Record<string, unknown>;
    if (payload.calendar === undefined || payload.calendar === null) return [];
    if (!Array.isArray(payload.calendar)) {
        throw new CommandValidationError(
            `Event ${event.id} requires calendar to be a list`,
        );
    }
    const sources: EntityCalendarSource[] = [];
    for (const entry of payload.calendar) {
        const source = sanitizeCalendarSource(entry);
        if (!source) {
            throw new CommandValidationError(
                `Event ${event.id} has an invalid calendar source`,
            );
        }
        sources.push(source);
    }
    return sources;
}

function requireString(event: ExtendedAppEvent, key: string): void {
    // SAFETY: payload was checked to be a non-array object by validateCommandEvents.
    const value = (event.payload as unknown as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new CommandValidationError(`Event ${event.id} requires ${key}`);
    }
}
