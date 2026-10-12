import { describe, expect, it } from 'vitest';

import { describeClashes, findClashes, withoutClashes, type EntityEdit } from './conflict-merge.js';

const update = (payload: Record<string, unknown>): EntityEdit => ({ type: 'CALENDAR_EVENT_UPDATED', payload: { id: 't1', ...payload } });
const removal: EntityEdit = { type: 'CALENDAR_EVENT_REMOVED', payload: { id: 't1' } };
const entity = 'calendar_event:t1';

describe('finding clashes between a local batch and accepted remote edits', () => {
    it('merges edits to different fields without asking', () => {
        expect(findClashes(entity, [update({ amount: 50 })], [update({ name: 'Rent' })])).toEqual([]);
    });

    it('treats the same new value on both sides as agreement', () => {
        expect(findClashes(entity, [update({ amount: 50 })], [update({ amount: 50 })])).toEqual([]);
        expect(findClashes(entity, [update({ items: { a: 1, b: 2 } })], [update({ items: { b: 2, a: 1 } })])).toEqual([]);
    });

    it('asks when both sides set one field to different values, using the last value of each', () => {
        const clashes = findClashes(entity,
            [update({ amount: 10 }), update({ amount: 50 })],
            [update({ amount: 20 }), update({ amount: 30, name: 'Rent' })]);
        expect(clashes).toEqual([{ kind: 'field', entityId: entity, field: 'amount', mine: 50, theirs: 30 }]);
    });

    it('treats clearing a field as a value of its own', () => {
        expect(findClashes(entity, [update({ note: null })], [update({ note: 'x' })]))
            .toEqual([{ kind: 'field', entityId: entity, field: 'note', mine: null, theirs: 'x' }]);
    });

    it('never restores a record another device deleted without asking', () => {
        expect(findClashes(entity, [update({ amount: 50 })], [update({ name: 'Rent' }), removal]))
            .toEqual([{ kind: 'edited_after_removed', entityId: entity }]);
        expect(findClashes(entity, [removal], [removal])).toEqual([]);
    });

    it('asks before deleting a record another device edited, and not for an empty edit', () => {
        expect(findClashes(entity, [removal], [update({ amount: 20 })]))
            .toEqual([{ kind: 'removed_after_edited', entityId: entity, fields: ['amount'] }]);
        expect(findClashes(entity, [removal], [update({})])).toEqual([]);
    });

    it('has nothing to compare when either side has no edits', () => {
        expect(findClashes(entity, [update({ amount: 1 })], [])).toEqual([]);
        expect(findClashes(entity, [], [update({ amount: 1 })])).toEqual([]);
        expect(findClashes(entity, [{ type: 'EVENT_TOMBSTONED', payload: { eventId: 'e' } }], [update({ amount: 1 })])).toEqual([]);
    });
});

describe('giving up the clashing values', () => {
    const row = (type: string, entityId: string, payload: Record<string, unknown>) => ({ type, entity_id: entityId, payload: JSON.stringify(payload) });
    const rows = [
        row('CALENDAR_EVENT_UPDATED', entity, { id: 't1', amount: 50, name: 'Rent' }),
        row('CALENDAR_EVENT_UPDATED', entity, { id: 't1', amount: 60 }),
        row('CALENDAR_EVENT_UPDATED', 'calendar_event:a1', { id: 'a1', amount: 5 }),
    ];

    it('drops only the clashing field and any event left empty', () => {
        const kept = withoutClashes(rows, [{ kind: 'field', entityId: entity, field: 'amount', mine: 60, theirs: 30 }]);
        expect(kept.map((item) => JSON.parse(item.payload))).toEqual([{ id: 't1', name: 'Rent' }, { id: 'a1', amount: 5 }]);
    });

    it('leaves a record deleted when the other device deleted it', () => {
        const kept = withoutClashes(rows, [{ kind: 'edited_after_removed', entityId: entity }]);
        expect(kept.map((item) => item.entity_id)).toEqual(['calendar_event:a1']);
    });

    it('does not send a deletion of a record the other device edited', () => {
        const batch = [row('CALENDAR_EVENT_REMOVED', entity, { id: 't1' }), row('CALENDAR_EVENT_UPDATED', 'calendar_event:a1', { id: 'a1', amount: 5 })];
        const kept = withoutClashes(batch, [{ kind: 'removed_after_edited', entityId: entity, fields: ['amount'] }]);
        expect(kept.map((item) => item.type)).toEqual(['CALENDAR_EVENT_UPDATED']);
    });

    it('returns the batch untouched when nothing clashed', () => {
        expect(withoutClashes(rows, [])).toEqual(rows);
    });
});

describe('describing clashes', () => {
    it('names the field with both values', () => {
        expect(describeClashes([
            { kind: 'field', entityId: entity, field: 'due_date', mine: '2026-10-05', theirs: '2026-10-09' },
            { kind: 'field', entityId: entity, field: 'note', mine: 'x'.repeat(100), theirs: null },
        ])).toBe(`Due date: yours 2026-10-05, theirs 2026-10-09 · Note: yours ${'x'.repeat(57)}…, theirs empty`);
    });

    it('explains a deletion on either side', () => {
        expect(describeClashes([{ kind: 'edited_after_removed', entityId: entity }]))
            .toBe('Calendar event was deleted on another device; your edit would restore it');
        expect(describeClashes([{ kind: 'removed_after_edited', entityId: 'calendar_event:p1', fields: ['name'] }]))
            .toBe('Calendar event was edited on another device; your deletion would discard that edit');
    });
});
