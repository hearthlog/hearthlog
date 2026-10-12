/**
 * Event fold for calendar feeds.
 *
 * The client projects entities with SQL; the Worker only has Ledger's accepted
 * events, so this module rebuilds the same calendar items in JavaScript. It
 * shares `selectReplayEvents` (tombstones, excisions, restores), the entity
 * definitions, and `calendarSourceDefinitions` with the client so both sides
 * agree on semantics and config validation.
 *
 * Pure module: no database, no browser APIs.
 */

import { ENTITY_DEFINITIONS } from '../event/entity-definitions.js';
import {
    selectReplayEvents,
    type ReplayEvent,
} from '../history/replay-selection.js';
import type { EntityCalendarFilter } from './config';
import {
    sanitizeCalendarSource,
    splitTitleRef,
    type EntityCalendarSource,
} from './config';
import {
    calendarSourceDefinitions,
    type CalendarSourceDefinition,
    type DynamicEntityDefinitionLike,
} from './registry';

/** Accepted event as delivered by the Ledger events endpoint. */
export interface AcceptedCalendarEvent {
    id: string;
    /** Log version. */
    version: number;
    type: string;
    entityId: string;
    entityVersion: number;
    timestamp?: number;
    payload: Record<string, unknown>;
}

export interface CalendarFeedWindow {
    /** Inclusive `YYYY-MM-DD`. */
    startDate: string;
    /** Inclusive `YYYY-MM-DD`. */
    endDate: string;
}

export interface FoldedCalendarItem {
    sourceKey: string;
    entityName: string;
    /** Human source label, used as the ICS CATEGORIES value. */
    label: string;
    id: string;
    title: string;
    subtitle: string;
    /** Clipped to the feed window for ranges. */
    startDate: string;
    /** Inclusive end date for multi-day items, else null. */
    endDate: string | null;
    startTime: string;
    endTime: string;
    params: Record<string, string>;
    pinned: boolean;
}

export interface FoldCalendarOptions {
    /** Feed source keys, or null for every source defined at serve time. */
    sources: readonly string[] | null;
    window: CalendarFeedWindow;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fold accepted events into calendar items. `headVersion` is the log's current
 * version and bounds the replay (a restore may reference an earlier prefix).
 */
export function foldCalendarItems(
    events: readonly AcceptedCalendarEvent[],
    headVersion: number,
    options: FoldCalendarOptions,
): FoldedCalendarItem[] {
    // SAFETY: selectReplayEvents returns the same objects it is given, so the
    // fold fields added by toFoldEvent survive the replay selection.
    const effective = selectReplayEvents(
        events.map(toFoldEvent),
        headVersion,
    ) as FoldEvent[];
    const sources = calendarSourceDefinitions(
        ENTITY_DEFINITIONS,
        dynamicDefinitionsFromEvents(effective),
        {
            // The Worker does not know tenant feature flags. Events can only
            // exist for features that were enabled when they were recorded, so
            // resolving every static definition is safe; source filtering is
            // per feed.
            approvedEntityNames: new Set(ENTITY_DEFINITIONS.map((def) => def.name)),
            approvedTables: new Set(ENTITY_DEFINITIONS.map((def) => def.table)),
            dynamicEnabled: true,
        },
    );
    const activeSources =
        options.sources === null
            ? sources
            : sources.filter((source) => options.sources!.includes(source.key));

    const mapping = entityEventMapping(activeSources);
    const entities = foldEntities(effective, mapping);
    const payloadKeysByEntity = new Map(
        sources.map((source) => [source.entityName, source.payloadKeys]),
    );
    const entityNameByTable = new Map(
        ENTITY_DEFINITIONS.map((definition) => [definition.table, definition.name]),
    );

    const items: FoldedCalendarItem[] = [];
    for (const state of entities.values()) {
        const rowId = rowIdOf(state.payload, state.entityId);
        for (const source of activeSources) {
            if (source.entityName !== state.entityName) continue;
            const item = buildItem(
                source,
                rowId,
                state.payload,
                entities,
                payloadKeysByEntity,
                entityNameByTable,
                options.window,
            );
            if (item) items.push(item);
        }
    }

    items.sort((left, right) =>
        left.startDate.localeCompare(right.startDate) ||
        left.startTime.localeCompare(right.startTime) ||
        left.sourceKey.localeCompare(right.sourceKey) ||
        left.id.localeCompare(right.id),
    );
    return items;
}

interface EntityState {
    entityName: string;
    entityId: string;
    payload: Record<string, unknown>;
    entityVersion: number;
}

/** A replay event that also carries the fold fields from the accepted event. */
interface FoldEvent extends ReplayEvent {
    entityId: string;
    entityVersion: number;
}

type EventKind = 'added' | 'updated' | 'removed';

function entityEventMapping(
    sources: readonly CalendarSourceDefinition[],
): Map<string, { entityName: string; kind: EventKind }> {
    const mapping = new Map<string, { entityName: string; kind: EventKind }>();
    for (const source of sources) {
        for (const kind of ['added', 'updated', 'removed'] as const) {
            mapping.set(`${source.eventPrefix}${kind.toUpperCase()}`, {
                entityName: source.entityName,
                kind,
            });
        }
    }
    return mapping;
}

function foldEntities(
    effective: readonly FoldEvent[],
    mapping: ReadonlyMap<string, { entityName: string; kind: EventKind }>,
): Map<string, EntityState> {
    const entities = new Map<string, EntityState>();
    for (const event of effective) {
        const target = mapping.get(event.type);
        if (!target) continue;
        if (target.kind === 'removed') {
            entities.delete(event.entityId);
            continue;
        }
        const payload = payloadOf(event);
        if (!payload) continue;
        const existing = entities.get(event.entityId);
        if (existing && existing.entityVersion > event.entityVersion) {
            continue;
        }
        entities.set(event.entityId, {
            entityName: target.entityName,
            entityId: event.entityId,
            payload,
            entityVersion: event.entityVersion,
        });
    }
    return entities;
}

function buildItem(
    source: CalendarSourceDefinition,
    rowId: string,
    payload: Record<string, unknown>,
    entities: ReadonlyMap<string, EntityState>,
    payloadKeysByEntity: ReadonlyMap<string, Readonly<Record<string, string>>>,
    entityNameByTable: ReadonlyMap<string, string>,
    window: CalendarFeedWindow,
): FoldedCalendarItem | null {
    const { config } = source;
    if (!passesFilters(payload, config.filters, source.payloadKeys)) return null;

    const startDate = dayValue(payload, source.payloadKeys, config.dateField);
    if (!startDate) return null;

    let subtitle = config.subtitleField
        ? textValue(payload, source.payloadKeys, config.subtitleField)
        : '';
    let endDate: string | null = null;

    if (config.endDateField) {
        const resolvedEnd = dayValue(payload, source.payloadKeys, config.endDateField);
        if (!resolvedEnd || resolvedEnd < startDate) return null;
        endDate = resolvedEnd;
    }

    if (config.parent) {
        const parentEntityName = entityNameByTable.get(config.parent.table);
        const parentId = textValue(payload, source.payloadKeys, config.parent.localField);
        const parent = parentEntityName && parentId
            ? entities.get(`${parentEntityName}:${parentId}`)
            : undefined;
        if (!parent) return null;
        const parentKeys = payloadKeysByEntity.get(parentEntityName!);
        if (!passesFilters(parent.payload, config.parent.filters, parentKeys ?? {})) {
            return null;
        }
        if (!subtitle) {
            subtitle = textValue(parent.payload, parentKeys ?? {}, config.parent.titleField);
        }
    }

    if (!inWindow(startDate, endDate, window)) return null;
    if (endDate) {
        endDate = endDate > window.endDate ? window.endDate : endDate;
    }
    const clippedStart = startDate < window.startDate ? window.startDate : startDate;

    const params: Record<string, string> = {};
    for (const [param, column] of Object.entries(config.params ?? {})) {
        params[param] = textValue(payload, source.payloadKeys, column);
    }

    return {
        sourceKey: source.key,
        entityName: source.entityName,
        label: source.label,
        id: rowId,
        title: titleOf(source, rowId, payload),
        subtitle,
        startDate: clippedStart,
        endDate,
        startTime: textValue(payload, source.payloadKeys, config.timeField),
        endTime: textValue(payload, source.payloadKeys, config.endTimeField),
        params,
        pinned: Boolean(readField(payload, source.payloadKeys, config.pinnedField)),
    };
}

function titleOf(
    source: CalendarSourceDefinition,
    rowId: string,
    payload: Record<string, unknown>,
): string {
    if (source.config.titleField) {
        const configured = titleRefValue(payload, source.payloadKeys, source.config.titleField);
        if (configured) return configured;
    }
    for (const ref of source.config.titleFallbacks ?? []) {
        const value = titleRefValue(payload, source.payloadKeys, ref);
        if (value) return value;
    }
    for (const fallback of ['title', 'name', 'label']) {
        if (source.fields.some((field) => field.name === fallback)) {
            const value = textValue(payload, source.payloadKeys, fallback);
            if (value) return value;
        }
    }
    return rowId;
}

/** Title ref value; `column#jsonKey` reads a JSON object key from a string. */
function titleRefValue(
    payload: Record<string, unknown>,
    payloadKeys: Readonly<Record<string, string>>,
    ref: string,
): string {
    const { column, jsonKey } = splitTitleRef(ref);
    const raw = readField(payload, payloadKeys, column);
    if (!jsonKey) return comparable(raw);
    if (typeof raw !== 'string' || raw.trim() === '') return '';
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return comparable((parsed as Record<string, unknown>)[jsonKey]);
        }
    } catch {
        return '';
    }
    return '';
}

function inWindow(
    startDate: string,
    endDate: string | null,
    window: CalendarFeedWindow,
): boolean {
    if (endDate) {
        return endDate >= window.startDate && startDate <= window.endDate;
    }
    return startDate >= window.startDate && startDate <= window.endDate;
}

function passesFilters(
    payload: Record<string, unknown>,
    filters: readonly EntityCalendarFilter[] | undefined,
    payloadKeys: Readonly<Record<string, string>>,
): boolean {
    for (const filter of filters ?? []) {
        const value = readField(payload, payloadKeys, filter.field);
        if (comparable(value) !== comparable(filter.equals)) return false;
    }
    return true;
}

function dayValue(
    payload: Record<string, unknown>,
    payloadKeys: Readonly<Record<string, string>>,
    field: string,
): string | null {
    const value = textValue(payload, payloadKeys, field).slice(0, 10);
    return DATE_PATTERN.test(value) ? value : null;
}

function textValue(
    payload: Record<string, unknown>,
    payloadKeys: Readonly<Record<string, string>>,
    field: string | undefined,
): string {
    if (!field) return '';
    return comparable(readField(payload, payloadKeys, field));
}

/** JSON scalar read from an event payload. */
type CalendarFieldValue = string | number | boolean | null;

function readField(
    payload: Record<string, unknown>,
    payloadKeys: Readonly<Record<string, string>>,
    field: string | undefined,
): CalendarFieldValue {
    if (!field) return null;
    const value = payload[payloadKeys[field] ?? field];
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    return String(value);
}

function comparable(value: unknown): string {
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    return String(value);
}

function rowIdOf(payload: Record<string, unknown>, entityId: string): string {
    if (typeof payload.id === 'string' && payload.id) return payload.id;
    const separator = entityId.indexOf(':');
    return separator >= 0 ? entityId.slice(separator + 1) : entityId;
}

function payloadOf(event: ReplayEvent): Record<string, unknown> | null {
    return event.payload && typeof event.payload === 'object'
        ? event.payload
        : null;
}

function toFoldEvent(event: AcceptedCalendarEvent): FoldEvent {
    return {
        id: event.id,
        type: event.type,
        logVersion: event.version,
        payload: event.payload ?? {},
        entityId: event.entityId,
        entityVersion: event.entityVersion,
    };
}

interface DynamicDefinitionState {
    name: string;
    tableName: string;
    fields: Array<{ name: string; type: string; payloadKey: string }>;
    calendar: EntityCalendarSource[];
    archived: boolean;
}

/** Replay `ENTITY_TYPE_*` events into the resolver's record shape. */
function dynamicDefinitionsFromEvents(
    effective: readonly ReplayEvent[],
): DynamicEntityDefinitionLike[] {
    const definitions = new Map<string, DynamicDefinitionState>();
    for (const event of effective) {
        const payload = payloadOf(event);
        if (!payload) continue;
        const id = typeof payload.id === 'string' ? payload.id : '';
        if (!id) continue;

        if (event.type === 'ENTITY_TYPE_DEFINED') {
            const name = typeof payload.name === 'string' ? payload.name : '';
            const tableName = typeof payload.tableName === 'string' ? payload.tableName : '';
            if (!name || !tableName || definitions.has(id)) continue;
            definitions.set(id, {
                name,
                tableName,
                fields: normalizeFields(payload.fields),
                calendar: normalizeCalendarPayload(payload.calendar),
                archived: false,
            });
            continue;
        }

        const state = definitions.get(id);
        if (!state) continue;
        if (event.type === 'ENTITY_TYPE_ARCHIVED') {
            state.archived = true;
            continue;
        }
        if (event.type !== 'ENTITY_TYPE_UPDATED') continue;

        if (payload.addFields !== undefined) {
            const added = normalizeFields(payload.addFields);
            for (const field of added) {
                if (!state.fields.some((existing) => existing.name === field.name)) {
                    state.fields.push(field);
                }
            }
        }
        if (Array.isArray(payload.updateFields)) {
            for (const update of payload.updateFields as Array<Record<string, unknown>>) {
                const name = typeof update.name === 'string' ? update.name : '';
                const index = state.fields.findIndex((field) => field.name === name);
                if (index < 0) continue;
                const field = { ...state.fields[index] };
                if (typeof update.payloadKey === 'string' && update.payloadKey) {
                    field.payloadKey = update.payloadKey;
                }
                if (typeof update.type === 'string') field.type = update.type;
                state.fields[index] = field;
            }
        }
        if (payload.calendar !== undefined) {
            state.calendar = normalizeCalendarPayload(payload.calendar);
        }
    }

    return [...definitions.values()]
        .filter((state) => !state.archived)
        .map((state) => ({
            name: state.name,
            table_name: state.tableName,
            fields_json: JSON.stringify(state.fields),
            calendar_json:
                state.calendar.length > 0
                    ? JSON.stringify(state.calendar)
                    : null,
        }));
}

function normalizeFields(value: unknown): Array<{ name: string; type: string; payloadKey: string }> {
    if (!Array.isArray(value)) return [];
    const fields: Array<{ name: string; type: string; payloadKey: string }> = [];
    for (const entry of value as Array<Record<string, unknown>>) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.type !== 'string') {
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

function normalizeCalendarPayload(value: unknown): EntityCalendarSource[] {
    if (!Array.isArray(value)) return [];
    const sources: EntityCalendarSource[] = [];
    for (const entry of value) {
        const source = sanitizeCalendarSource(entry);
        if (source) sources.push(source);
    }
    return sources;
}
