import { afterEach, describe, expect, it } from 'vitest';
import { createProjectionTestDatabase, type ProjectionTestDatabase } from '../testing/projection-database.js';

const open: ProjectionTestDatabase[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((fixture) => fixture.destroy()));
});

function fixture(history = false): ProjectionTestDatabase {
    const created = createProjectionTestDatabase({ tables: ['calendar_events'], history });
    open.push(created);
    return created;
}

describe('canonical projection boundaries', () => {
    it('uses temporal tombstones in history and includes pending local events only in Now', async () => {
        const db = fixture(true);
        const entityId = 'calendar_event:event-1';
        db.addEvent({ id: 'add', type: 'CALENDAR_EVENT_ADDED', timestamp: 1_000, entityId, entityVersion: 1, logVersion: 1,
            payload: { id: 'event-1', title: 'Dentist', eventDate: '2026-10-12' } });
        db.addEvent({ id: 'update', type: 'CALENDAR_EVENT_UPDATED', timestamp: 2_000, entityId, entityVersion: 2, logVersion: 3, tombstoned: true,
            payload: { id: 'event-1', title: 'Dentist, moved' } });
        db.addEvent({ id: 'tombstone', type: 'EVENT_TOMBSTONED', timestamp: 3_000, entityId: null, entityVersion: null, logVersion: 4,
            payload: { eventId: 'update' } });
        db.addEvent({ id: 'local', type: 'CALENDAR_EVENT_UPDATED', timestamp: 4_000, entityId, entityVersion: 3, logVersion: null, syncState: 'pending',
            payload: { id: 'event-1', title: 'Dentist, pending' } });
        db.addEvent({ id: 'rejected', type: 'CALENDAR_EVENT_UPDATED', timestamp: 5_000, entityId, entityVersion: 4, logVersion: 5, projectionState: 'rejected',
            payload: { id: 'event-1', title: 'Dentist, rejected' } });

        const projectHistory = async (version: number) => {
            db.sqlite.exec('DELETE FROM history.calendar_events');
            await db.rebuild('calendar_event', { version, schema: 'history' });
            return db.sqlite.prepare('SELECT * FROM history.calendar_events').get() as Record<string, unknown>;
        };

        expect((await projectHistory(1)).title).toBe('Dentist');
        expect((await projectHistory(3)).title).toBe('Dentist, moved');
        const afterTombstone = await projectHistory(4);
        expect(afterTombstone.title).toBe('Dentist');
        expect(afterTombstone.created_at).toBe('1970-01-01 00:00:01');
        expect(afterTombstone.updated_at).toBe('1970-01-01 00:00:01');

        await db.rebuild('calendar_event');
        const current = db.sqlite.prepare('SELECT * FROM main.calendar_events').get() as Record<string, unknown>;
        expect(current.title).toBe('Dentist, pending');
    });
});

describe('field presence', () => {
    it('resets a field to its default on an explicit null and keeps it when the key is omitted', async () => {
        const db = fixture();
        const entityId = 'calendar_event:event-1';
        const row = () => db.sqlite.prepare('SELECT title, notes, start_time FROM calendar_events').get();
        db.addEvent({ id: 'add', type: 'CALENDAR_EVENT_ADDED', timestamp: 1_000, entityId, entityVersion: 1, logVersion: 1,
            payload: { id: 'event-1', title: 'Dentist', eventDate: '2026-10-12', startTime: '09:00', notes: 'Bring the card' } });
        db.addEvent({ id: 'rename', type: 'CALENDAR_EVENT_UPDATED', timestamp: 2_000, entityId, entityVersion: 2, logVersion: 2,
            payload: { id: 'event-1', title: 'Dentist, Brno' } });
        await db.project('calendar_event', [entityId]);
        expect(row()).toEqual({ title: 'Dentist, Brno', notes: 'Bring the card', start_time: '09:00' });

        db.addEvent({ id: 'clear', type: 'CALENDAR_EVENT_UPDATED', timestamp: 3_000, entityId, entityVersion: 3, logVersion: 3,
            payload: { id: 'event-1', notes: null } });
        await db.project('calendar_event', [entityId]);
        expect(row()).toEqual({ title: 'Dentist, Brno', notes: '', start_time: '09:00' });
    });
});
