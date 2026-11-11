import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { createLocalDatabase } from '../testing/local-database.js';

/**
 * Opening a history action compares only the records it touched. That must say exactly what the full comparison of
 * two workspace states says, for every kind of change an ordinary action makes.
 */

const SCOPE = { tenantId: 'tenant', logId: 'log' };
const state = vi.hoisted(() => ({ database: null as unknown as Kysely<Database> }));
vi.mock('../db/index.js', () => ({
    get db() { return state.database; },
    requireActiveContext: async () => SCOPE,
}));
vi.mock('./baseline.js', () => ({ baselineVersion: async () => 0 }));

const { readTouchedChanges, readWorkspaceChanges } = await import('./point-snapshot.js');

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

describe('history action changes', () => {
    it('reads the same from the touched records as from two full workspace states', async () => {
        const { database, sqlite } = createLocalDatabase(['calendar_events']);
        closers.push(() => database.destroy());
        state.database = database;
        const r1 = '00000000-0000-4000-8000-000000000001';
        const r2 = '00000000-0000-4000-8000-000000000002';
        const actions: Array<Array<{ type: string; record: string; payload: Record<string, unknown> }>> = [
            [{ type: 'CALENDAR_EVENT_ADDED', record: r1, payload: { title: 'Dentist', eventDate: '2026-10-12', notes: 'bring card' } }],
            [{ type: 'CALENDAR_EVENT_ADDED', record: r2, payload: { title: 'Gym', eventDate: '2026-10-13' } },
                { type: 'CALENDAR_EVENT_UPDATED', record: r1, payload: { title: 'Dentist at 9' } }],
            [{ type: 'CALENDAR_EVENT_UPDATED', record: r1, payload: { notes: null } }],
            [{ type: 'CALENDAR_EVENT_REMOVED', record: r2, payload: {} }],
            [{ type: 'CALENDAR_EVENT_ADDED', record: r2, payload: { title: 'Gym again', eventDate: '2026-10-20' } }],
            [{ type: 'CALENDAR_EVENT_UPDATED', record: r2, payload: { pinned: true } },
                { type: 'CALENDAR_EVENT_UPDATED', record: r2, payload: { startTime: '07:30' } }],
        ];
        const insert = sqlite.prepare(`INSERT INTO raw_events (id, tenant_id, log_id, local_batch_id, local_sequence, action_id,
            action_index, action_size, type, timestamp, payload, entity_id, entity_version, log_version, sync_state)
            VALUES (?, 'tenant', 'log', 'server', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`);
        const entityVersions = new Map<string, number>();
        const boundaries: Array<[number, number]> = [];
        let version = 0;
        for (const [actionNumber, events] of actions.entries()) {
            const previous = version;
            events.forEach((event, index) => {
                version += 1;
                const entityVersion = (entityVersions.get(event.record) ?? 0) + 1;
                entityVersions.set(event.record, entityVersion);
                insert.run(`event-${version}`, version, `action-${actionNumber}`, index, events.length, event.type,
                    1_700_000_000_000 + version * 60_000, JSON.stringify({ id: event.record, ...event.payload }),
                    `calendar_event:${event.record}`, entityVersion, version);
            });
            boundaries.push([previous, version]);
        }
        sqlite.exec(`INSERT INTO log_sync_state (tenant_id, log_id, downloaded_head_version, projected_head_version) VALUES ('tenant', 'log', ${version}, ${version})`);

        for (const [previous, through] of boundaries) {
            const touched = await readTouchedChanges(previous, through, SCOPE);
            expect(touched, `action ending at ${through}`).not.toBeNull();
            expect(touched!.length, `action ending at ${through}`).toBeGreaterThan(0);
            expect(touched, `action ending at ${through}`).toEqual(await readWorkspaceChanges(previous, through, SCOPE));
        }
    });
});
