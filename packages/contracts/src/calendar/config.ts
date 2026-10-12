/**
 * Calendar source configuration.
 *
 * An entity definition (static, in `entity-definitions.ts`) or a dynamic
 * entity type (runtime, in `entity_type_definitions.calendar_json`) declares
 * which of its fields form a calendar item. This module owns the shape, the
 * structural parser for untrusted JSON, and the semantic validation used by
 * the entity editor and the meta-event handlers.
 *
 * The module must stay free of Svelte, `$app/*`, and browser imports: the
 * frontend Worker reuses it when generating ICS feeds, and the codegen and
 * deployment scripts import it from Node.
 */

/** A declarative equality filter, e.g. `archived = 0`. Never raw SQL. */
export interface EntityCalendarFilter {
    /** Column on the entity's own table. */
    field: string;
    equals: string | number | boolean;
}

/**
 * Optional parent row joined for context and filtering, so archived parents
 * hide their children and the parent title can be shown.
 */
export interface EntityCalendarParent {
    /** Parent table name; must be part of the tenant's approved tables. */
    table: string;
    /** Column on this entity holding the parent id. */
    localField: string;
    /** Parent column shown as the item subtitle when no `subtitleField` is set. */
    titleField: string;
    filters?: EntityCalendarFilter[];
}

export type CalendarTone = 'accent' | 'warning' | 'negative' | 'positive' | 'info' | 'muted';

/** How a source's items look and where they open. Declared by static entity definitions only. */
export interface CalendarSourcePresentation {
    /** An `mdi` icon name; the calendar UI resolves it (see `components/calendar/source-icons.ts`). */
    icon: string;
    tone: CalendarTone;
    /**
     * Href template. Placeholders: `{id}`, `{date}`, `{year}`, `{month}`,
     * `{entity}` (the entity name), and any key of the source's `params`.
     */
    href: string | null;
    /** Lower sorts first inside a day. */
    rank: number;
}

/** A menu row several sources share (Invoices: issued and received). */
export interface CalendarSourceGroup {
    id: string;
    label: string;
    icon: string;
}

/**
 * How one entity's records appear on the calendar and in ICS feeds.
 */
export interface EntityCalendarSource {
    /**
     * Stable identifier used in the source preference, the presentation
     * registry, and ICS UIDs. Defaults to `<entity>-<dateField>` so a single
     * entity can expose several dates without collisions.
     */
    key?: string;
    /** Column with the item date: `YYYY-MM-DD` or an ISO local datetime. */
    dateField: string;
    /** Inclusive end column for multi-day items. */
    endDateField?: string;
    /** `HH:mm` column; empty/absent means all-day. */
    timeField?: string;
    endTimeField?: string;
    /**
     * Title column; a `column#jsonKey` ref reads a JSON object key from a text
     * column (e.g. `customer_snapshot#name`). Defaults to title | name | label.
     */
    titleField?: string;
    /**
     * Columns tried in order when `titleField` is empty, e.g.
     * `["description", "invoice_number", "file_name"]`.
     */
    titleFallbacks?: string[];
    /** Optional secondary line, e.g. an invoice number. */
    subtitleField?: string;
    /** Declarative equality filters, e.g. archived = 0. */
    filters?: EntityCalendarFilter[];
    /** Optional parent row for context (subtitle) and filtering. */
    parent?: EntityCalendarParent;
    /**
     * Extra columns copied into href placeholders, e.g.
     * `{ parentId: "parent_id" }` for `/items/{parentId}#day-{date}`.
     */
    params?: Record<string, string>;
    /** Boolean column rendered as the pin marker (calendar events only today). */
    pinnedField?: string;
    /** Agenda chip / ICS CATEGORIES label, e.g. "Transaction due". */
    label: string;
    /**
     * Icon, tone, link, and order. Only static definitions declare it: the
     * parser for runtime entity types rejects it, so those sources keep the
     * neutral look and open the entity list.
     */
    presentation?: CalendarSourcePresentation;
    /** The menu row the source belongs to; a source without one is its own row. */
    group?: CalendarSourceGroup;
}

/** Minimal field shape needed for semantic validation. */
export interface CalendarFieldLike {
    name: string;
    type: string;
}

export const MAX_CALENDAR_SOURCES_PER_ENTITY = 8;
const MAX_FILTERS_PER_ENTITY = 8;
const MAX_PARAMS_PER_SOURCE = 8;
const MAX_TITLE_FALLBACKS = 4;
const MAX_LABEL_LENGTH = 40;

const TITLE_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(#[A-Za-z_][A-Za-z0-9_]*)?$/;

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_PARAMS = new Set([
    'id',
    'date',
    'year',
    'month',
    'title',
    'subtitle',
    'startTime',
    'endTime',
]);

/** Columns a date source may point at; ISO timestamps are day-normalized. */
const DATE_FIELD_TYPES = new Set(['datetime', 'string']);
const TEXT_FIELD_TYPES = new Set(['string']);

export function normalizeCalendarSources(
    calendar: EntityCalendarSource | EntityCalendarSource[] | undefined,
): EntityCalendarSource[] {
    if (!calendar) return [];
    return Array.isArray(calendar) ? calendar : [calendar];
}

export function calendarSourceKey(
    entityName: string,
    source: EntityCalendarSource,
): string {
    return source.key ?? `${entityName}-${source.dateField}`;
}

export interface TitleRef {
    column: string;
    jsonKey?: string;
}

/** Split a `column#jsonKey` title ref into its parts. */
export function splitTitleRef(ref: string): TitleRef {
    const hash = ref.indexOf('#');
    return hash < 0
        ? { column: ref }
        : { column: ref.slice(0, hash), jsonKey: ref.slice(hash + 1) };
}

function isTitleRef(value: unknown): value is string {
    return typeof value === 'string' && TITLE_REF_PATTERN.test(value);
}

function isTitleRefOptional(value: unknown): boolean {
    return value === undefined || isTitleRef(value);
}

function sanitizeTitleRefs(value: unknown, max: number): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) {
        return null;
    }
    const refs: string[] = [];
    for (const entry of value) {
        if (!isTitleRef(entry) || refs.includes(entry)) return null;
        refs.push(entry);
    }
    return refs;
}

/**
 * Structurally validate a value parsed from JSON (dynamic definitions are
 * user data). Returns null when the value is not a well-formed source.
 * Unknown properties are rejected so typos surface instead of being ignored.
 */
export function sanitizeCalendarSource(value: unknown): EntityCalendarSource | null {
    if (!isRecord(value)) return null;
    const allowed = new Set([
        'key',
        'dateField',
        'endDateField',
        'timeField',
        'endTimeField',
        'titleField',
        'titleFallbacks',
        'subtitleField',
        'filters',
        'parent',
        'params',
        'pinnedField',
        'label',
    ]);
    for (const prop of Object.keys(value)) {
        if (!allowed.has(prop)) return null;
    }
    if (!isIdentifier(value.dateField)) return null;
    if (!isIdentifierOptional(value.endDateField)) return null;
    if (!isIdentifierOptional(value.timeField)) return null;
    if (!isIdentifierOptional(value.endTimeField)) return null;
    if (!isTitleRefOptional(value.titleField)) return null;
    if (!isIdentifierOptional(value.subtitleField)) return null;
    if (!isIdentifierOptional(value.pinnedField)) return null;
    if (typeof value.label !== 'string') return null;
    const label = value.label.trim();
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
    if (value.key !== undefined && !isCalendarKey(value.key)) return null;

    let titleFallbacks: string[] | undefined;
    if (value.titleFallbacks !== undefined) {
        const parsedFallbacks = sanitizeTitleRefs(value.titleFallbacks, MAX_TITLE_FALLBACKS);
        if (!parsedFallbacks) return null;
        titleFallbacks = parsedFallbacks;
    }

    const filters = sanitizeFilters(value.filters);
    if (filters === null) return null;

    let parent: EntityCalendarParent | undefined;
    if (value.parent !== undefined) {
        const parsedParent = sanitizeParent(value.parent);
        if (!parsedParent) return null;
        parent = parsedParent;
    }

    let params: Record<string, string> | undefined;
    if (value.params !== undefined) {
        const parsedParams = sanitizeParams(value.params);
        if (!parsedParams) return null;
        params = parsedParams;
    }

    return {
        ...(value.key !== undefined ? { key: value.key as string } : {}),
        dateField: value.dateField,
        ...(value.endDateField !== undefined
            ? { endDateField: value.endDateField as string }
            : {}),
        ...(value.timeField !== undefined
            ? { timeField: value.timeField as string }
            : {}),
        ...(value.endTimeField !== undefined
            ? { endTimeField: value.endTimeField as string }
            : {}),
        ...(value.titleField !== undefined
            ? { titleField: value.titleField as string }
            : {}),
        ...(titleFallbacks ? { titleFallbacks } : {}),
        ...(value.subtitleField !== undefined
            ? { subtitleField: value.subtitleField as string }
            : {}),
        ...(filters.length > 0 ? { filters } : {}),
        ...(parent ? { parent } : {}),
        ...(params ? { params } : {}),
        ...(value.pinnedField !== undefined
            ? { pinnedField: value.pinnedField as string }
            : {}),
        label,
    };
}

/**
 * Parse a `calendar_json` column or meta-event payload. Invalid values are
 * dropped so a corrupt definition degrades to "no calendar dates" instead of
 * breaking the calendar page.
 */
export function parseCalendarConfig(raw: string | null | undefined): EntityCalendarSource[] {
    if (!raw) return [];
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(value)) return [];
    const sources: EntityCalendarSource[] = [];
    for (const entry of value.slice(0, MAX_CALENDAR_SOURCES_PER_ENTITY)) {
        const source = sanitizeCalendarSource(entry);
        if (source) sources.push(source);
    }
    return sources;
}

export function serializeCalendarConfig(
    sources: EntityCalendarSource[],
): string | null {
    if (sources.length === 0) return null;
    return JSON.stringify(sources);
}

/**
 * Semantic validation against the entity's own fields. Returns user-facing
 * error messages; an empty array means the config is valid.
 */
export function validateCalendarConfig(
    entityName: string,
    calendar: EntityCalendarSource | EntityCalendarSource[] | undefined,
    fields: readonly CalendarFieldLike[],
    options: { parentTables?: ReadonlySet<string> } = {},
): string[] {
    const sources = normalizeCalendarSources(calendar);
    const errors: string[] = [];
    if (sources.length === 0) return errors;
    if (sources.length > MAX_CALENDAR_SOURCES_PER_ENTITY) {
        errors.push(`Use at most ${MAX_CALENDAR_SOURCES_PER_ENTITY} calendar dates`);
    }

    const fieldTypes = new Map(fields.map((field) => [field.name, field.type]));
    const seenKeys = new Set<string>();

    sources.forEach((source, index) => {
        const where = sources.length > 1 ? `Calendar date ${index + 1}: ` : '';
        validateSourceFields(source, where, fieldTypes, errors);
        validateFilters(source.filters, `${where}filter`, fieldTypes, errors);
        if (source.parent) {
            validateParent(source.parent, where, fieldTypes, options.parentTables, errors);
            validateFilters(source.parent.filters, `${where}parent filter`, null, errors);
        }
        validateParams(source.params, where, fieldTypes, errors);
        validateKey(entityName, source, where, seenKeys, errors);
    });

    return errors;
}

function validateSourceFields(
    source: EntityCalendarSource,
    where: string,
    fieldTypes: ReadonlyMap<string, string>,
    errors: string[],
): void {
    const dateType = fieldTypes.get(source.dateField);
    if (dateType === undefined) {
        errors.push(`${where}date field "${source.dateField}" does not exist`);
    } else if (!DATE_FIELD_TYPES.has(dateType)) {
        errors.push(`${where}date field "${source.dateField}" must be a date`);
    }

    for (const [label, value, types] of [
        ['end date', source.endDateField, DATE_FIELD_TYPES],
        ['time', source.timeField, TEXT_FIELD_TYPES],
        ['end time', source.endTimeField, TEXT_FIELD_TYPES],
        ['subtitle', source.subtitleField, null],
        ['pin', source.pinnedField, null],
    ] as const) {
        if (!value) continue;
        const type = fieldTypes.get(value);
        if (type === undefined) {
            errors.push(`${where}${label} field "${value}" does not exist`);
        } else if (types && !types.has(type)) {
            errors.push(`${where}${label} field "${value}" has the wrong type`);
        }
    }

    if (source.endDateField && source.endDateField === source.dateField) {
        errors.push(`${where}end date must differ from the date field`);
    }
    if (source.timeField && source.timeField === source.dateField) {
        errors.push(`${where}time must differ from the date field`);
    }
    validateTitleRef(source.titleField, 'title', where, fieldTypes, errors);
    for (const ref of source.titleFallbacks ?? []) {
        validateTitleRef(ref, 'title fallback', where, fieldTypes, errors);
    }
    if (source.label.trim().length === 0) {
        errors.push(`${where}add a label`);
    }
}

function validateTitleRef(
    ref: string | undefined,
    label: string,
    where: string,
    fieldTypes: ReadonlyMap<string, string>,
    errors: string[],
): void {
    if (!ref) return;
    const { column, jsonKey } = splitTitleRef(ref);
    const type = fieldTypes.get(column);
    if (type === undefined) {
        errors.push(`${where}${label} "${column}" does not exist`);
        return;
    }
    if (jsonKey && !TEXT_FIELD_TYPES.has(type)) {
        errors.push(`${where}${label} "${column}" must be text to read #${jsonKey}`);
    }
}

function validateFilters(
    filters: readonly EntityCalendarFilter[] | undefined,
    prefix: string,
    fieldTypes: ReadonlyMap<string, string> | null,
    errors: string[],
): void {
    for (const filter of filters ?? []) {
        if (!isIdentifier(filter.field)) {
            errors.push(`${prefix} field is invalid`);
        } else if (fieldTypes && fieldTypes.get(filter.field) === undefined) {
            errors.push(`${prefix} field "${filter.field}" does not exist`);
        }
        if (!isFilterValue(filter.equals)) {
            errors.push(`${prefix} values must be text, numbers, or booleans`);
        }
    }
}

function validateParent(
    parent: EntityCalendarParent,
    where: string,
    fieldTypes: ReadonlyMap<string, string>,
    parentTables: ReadonlySet<string> | undefined,
    errors: string[],
): void {
    if (!isIdentifier(parent.table)) {
        errors.push(`${where}parent table is invalid`);
    } else if (parentTables && !parentTables.has(parent.table)) {
        errors.push(`${where}parent table "${parent.table}" is not available`);
    }
    if (fieldTypes.get(parent.localField) === undefined) {
        errors.push(`${where}parent link field "${parent.localField}" does not exist`);
    }
    if (!isIdentifier(parent.titleField)) {
        errors.push(`${where}parent title field is invalid`);
    }
}

function validateParams(
    params: Record<string, string> | undefined,
    where: string,
    fieldTypes: ReadonlyMap<string, string>,
    errors: string[],
): void {
    for (const [param, column] of Object.entries(params ?? {})) {
        if (!PARAM_PATTERN.test(param) || RESERVED_PARAMS.has(param)) {
            errors.push(`${where}href placeholder "{${param}}" is reserved`);
        }
        if (fieldTypes.get(column) === undefined) {
            errors.push(`${where}href field "${column}" does not exist`);
        }
    }
}

function validateKey(
    entityName: string,
    source: EntityCalendarSource,
    where: string,
    seenKeys: Set<string>,
    errors: string[],
): void {
    const key = calendarSourceKey(entityName, source);
    if (!isCalendarKey(key)) {
        errors.push(`${where}key "${key}" must be lowercase letters, digits, dashes, or underscores`);
    } else if (seenKeys.has(key)) {
        errors.push(`${where}key "${key}" is used more than once`);
    }
    seenKeys.add(key);
}

function sanitizeFilters(value: unknown): EntityCalendarFilter[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_FILTERS_PER_ENTITY) return null;
    const filters: EntityCalendarFilter[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) return null;
        if (!isIdentifier(entry.field) || !isFilterValue(entry.equals)) return null;
        filters.push({ field: entry.field, equals: entry.equals });
    }
    return filters;
}

function sanitizeParent(value: unknown): EntityCalendarParent | null {
    if (!isRecord(value)) return null;
    const allowed = new Set(['table', 'localField', 'titleField', 'filters']);
    for (const prop of Object.keys(value)) {
        if (!allowed.has(prop)) return null;
    }
    if (
        !isIdentifier(value.table) ||
        !isIdentifier(value.localField) ||
        !isIdentifier(value.titleField)
    ) {
        return null;
    }
    const filters = sanitizeFilters(value.filters);
    if (filters === null) return null;
    return {
        table: value.table,
        localField: value.localField,
        titleField: value.titleField,
        ...(filters.length > 0 ? { filters } : {}),
    };
}

function sanitizeParams(value: unknown): Record<string, string> | null {
    if (!isRecord(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > MAX_PARAMS_PER_SOURCE) return null;
    const params: Record<string, string> = {};
    for (const [param, column] of entries) {
        if (!PARAM_PATTERN.test(param) || RESERVED_PARAMS.has(param)) return null;
        if (!isIdentifier(column)) return null;
        params[param] = column;
    }
    return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function isIdentifierOptional(value: unknown): boolean {
    return value === undefined || isIdentifier(value);
}

function isCalendarKey(value: unknown): value is string {
    return typeof value === 'string' && KEY_PATTERN.test(value);
}

function isFilterValue(value: unknown): value is string | number | boolean {
    return (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    );
}
