/**
 * Merging a local batch with edits another device already had accepted.
 *
 * An update event carries only the fields it changed, so two devices that edit
 * different fields of one record merge by simply sending the local batch again
 * on top of the other device's events. A real clash is decided by a person:
 * both devices set one field to different values, one device deleted a record
 * the other edited, or the other way round. Nothing here rewrites a stored
 * event; a resolution is either the unchanged batch sent again, or a new batch
 * without the values the person gave up.
 */

export interface EntityEdit {
    type: string;
    payload: Record<string, unknown>;
}

export type EntityClash =
    /** Both devices set one field to different values. */
    | { kind: 'field'; entityId: string; field: string; mine: unknown; theirs: unknown }
    /** Another device deleted the record this batch edits; sending would restore it. */
    | { kind: 'edited_after_removed'; entityId: string }
    /** This batch deletes a record another device edited since. */
    | { kind: 'removed_after_edited'; entityId: string; fields: string[] };

type EditKind = 'added' | 'updated' | 'removed';

/** Entity events end in _ADDED, _UPDATED or _REMOVED; anything else is not an edit. */
function editKind(type: string): EditKind | null {
    if (type.endsWith('_ADDED')) return 'added';
    if (type.endsWith('_UPDATED')) return 'updated';
    if (type.endsWith('_REMOVED')) return 'removed';
    return null;
}

/** The value each field ends with: the last event that names it wins. */
function finalFields(edits: readonly EntityEdit[]): Map<string, unknown> {
    const fields = new Map<string, unknown>();
    for (const edit of edits) {
        const kind = editKind(edit.type);
        if (kind !== 'added' && kind !== 'updated') continue;
        for (const [key, value] of Object.entries(edit.payload)) {
            if (key !== 'id') fields.set(key, value);
        }
    }
    return fields;
}

function lastKind(edits: readonly EntityEdit[]): EditKind | null {
    for (let index = edits.length - 1; index >= 0; index--) {
        const kind = editKind(edits[index]!.type);
        if (kind) return kind;
    }
    return null;
}

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, nested]) => [key, canonical(nested)]),
        );
    }
    return value;
}

/**
 * What needs a decision between this batch's edits to one record (`mine`, in
 * order) and the edits other devices had accepted since this batch's base
 * version (`theirs`, in order). No clash means the batch can be sent again as is.
 */
export function findClashes(
    entityId: string,
    mine: readonly EntityEdit[],
    theirs: readonly EntityEdit[],
): EntityClash[] {
    const mineFinal = lastKind(mine);
    const theirsFinal = lastKind(theirs);
    if (mineFinal === null || theirsFinal === null) return [];

    if (theirsFinal === 'removed') {
        return mineFinal === 'removed' ? [] : [{ kind: 'edited_after_removed', entityId }];
    }
    if (mineFinal === 'removed') {
        const touched = [...finalFields(theirs).keys()];
        return touched.length > 0 ? [{ kind: 'removed_after_edited', entityId, fields: touched }] : [];
    }

    const mineFields = finalFields(mine);
    const clashes: EntityClash[] = [];
    for (const [field, theirValue] of finalFields(theirs)) {
        if (!mineFields.has(field)) continue;
        const myValue = mineFields.get(field);
        if (!sameValue(myValue, theirValue)) {
            clashes.push({ kind: 'field', entityId, field, mine: myValue, theirs: theirValue });
        }
    }
    return clashes;
}

export interface BatchRow {
    type: string;
    entity_id: string | null;
    payload: string;
}

/**
 * The batch without what the person gave up: a clashing field is dropped from
 * every event that sets it (an event left with nothing but its id is dropped),
 * a record the other device deleted is left deleted, and a deletion of a record
 * the other device edited is not sent.
 */
export function withoutClashes<T extends BatchRow>(rows: readonly T[], clashes: readonly EntityClash[]): T[] {
    const kept: T[] = [];
    for (const row of rows) {
        const own = clashes.filter((clash) => clash.entityId === row.entity_id);
        const kind = editKind(row.type);
        if (own.length === 0 || kind === null) {
            kept.push(row);
            continue;
        }
        if (own.some((clash) => clash.kind === 'edited_after_removed')) continue;
        if (kind === 'removed' && own.some((clash) => clash.kind === 'removed_after_edited')) continue;
        const dropped = new Set(own.flatMap((clash) => (clash.kind === 'field' ? [clash.field] : [])));
        if (dropped.size === 0 || kind === 'removed') {
            kept.push(row);
            continue;
        }
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        for (const field of dropped) delete payload[field];
        if (Object.keys(payload).every((key) => key === 'id')) continue;
        kept.push({ ...row, payload: JSON.stringify(payload) });
    }
    return kept;
}

export function humanizeField(name: string): string {
    const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim().toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A value as a person would read it in a one-line summary. */
export function formatClashValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return 'empty';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function describeClash(clash: EntityClash): string {
    switch (clash.kind) {
        case 'field':
            return `${humanizeField(clash.field)}: yours ${formatClashValue(clash.mine)}, theirs ${formatClashValue(clash.theirs)}`;
        case 'edited_after_removed':
            return `${humanizeField(clash.entityId.split(':')[0] ?? 'record')} was deleted on another device; your edit would restore it`;
        case 'removed_after_edited':
            return `${humanizeField(clash.entityId.split(':')[0] ?? 'record')} was edited on another device; your deletion would discard that edit`;
    }
}

export function describeClashes(clashes: readonly EntityClash[]): string {
    return clashes.map(describeClash).join(' · ');
}
