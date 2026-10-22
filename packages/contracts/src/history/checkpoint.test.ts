import { describe, expect, it } from 'vitest';
import { buildCheckpointEvents, checkpointEntityEvents, checkpointSelection, type CheckpointEvent } from './checkpoint.js';
import { selectReplayEvents } from './replay-selection.js';

const event = (version: number, payload: Record<string, unknown>, type = 'RECORD_UPDATED'): CheckpointEvent => ({
    id: `event-${version}`, entityId: 'record:one', entityVersion: version, version, type, timestamp: version * 1000, payload,
});

describe('checkpoint replay witnesses', () => {
    it('matches full replay membership across restores, excisions, and undo of earlier directives', () => {
        const source = [event(1, { id: 'one' }, 'RECORD_ADDED'), event(2, { id: 'one', title: 'Edited' }),
            event(3, { targetVersion: 1 }, 'WORKSPACE_RESTORED'), event(4, { id: 'one', title: 'After restore' }),
            event(5, { eventId: 'event-3' }, 'EVENT_TOMBSTONED'), event(6, { eventIds: ['event-2'] }, 'EVENTS_EXCISED'),
            event(7, { eventId: 'event-6' }, 'EVENT_TOMBSTONED')];
        for (let through = 1; through <= source.length; through++) {
            const prefix = source.filter(event => event.version <= through);
            const expected = selectReplayEvents(prefix.map(event => ({ ...event, logVersion: event.version })), through).map(event => event.id);
            const selected = checkpointSelection(prefix.filter(event => ['WORKSPACE_RESTORED', 'EVENTS_EXCISED', 'EVENT_TOMBSTONED'].includes(event.type)), through);
            expect(prefix.filter(selected).map(event => event.id)).toEqual(expected);
        }
    });
    it('preserves explicit null, unknown keys, creation time and the latest accepted version while reducing repeated updates', () => {
        const source = [event(1, { id: 'one', title: 'first', future: ['preserved'] }, 'RECORD_ADDED'),
            event(2, { id: 'one', title: 'second' }), event(3, { id: 'one', title: null }), event(4, { id: 'one', note: '' })];
        const result = checkpointEntityEvents(source);
        expect(result.map(value => value.version)).toEqual([1, 3, 4]);
        expect(Object.assign({}, ...result.map(value => value.payload))).toEqual(Object.assign({}, ...source.map(value => value.payload)));
        expect(Math.min(...result.map(value => value.timestamp))).toBe(1000);
    });
    it('retains lifecycle transitions and arbitrary definition events without inventing source facts', () => {
        const source = [event(1, { id: 'one' }, 'RECORD_ADDED'), event(2, { id: 'one' }, 'RECORD_REMOVED'),
            event(3, { id: 'one' }, 'RECORD_ADDED'), event(4, { fields: ['old'] }, 'ENTITY_TYPE_DEFINED'),
            event(5, { fields: ['new'] }, 'ENTITY_TYPE_UPDATED')];
        expect(checkpointEntityEvents(source)).toEqual(source);
    });
    it('resolves a restore and undo of the restore before reducing state', () => {
        const source = [event(1, { id: 'one', title: 'first' }, 'RECORD_ADDED'), event(2, { id: 'one', title: 'second' }),
            event(3, { targetVersion: 1 }, 'WORKSPACE_RESTORED')];
        expect(buildCheckpointEvents(source, 3).map(value => value.version)).toEqual([1]);
        source.push(event(4, { eventId: 'event-3' }, 'EVENT_TOMBSTONED'));
        expect(buildCheckpointEvents(source, 4).map(value => value.version)).toEqual([1, 2]);
    });
});
