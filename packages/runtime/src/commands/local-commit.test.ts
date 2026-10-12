import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

import type { ActiveContext, Database } from '../db/index.js';
import type {
    AddCalendarEventEvent,
    EntityTypeDefinedEvent,
    RemoveCalendarEventEvent,
    UpdateCalendarEventEvent,
} from '../event/index.js';
import {
    createEntityProjector,
    PROJECTION_CONFIGS,
} from '../event/projection-builder.js';
import { commitLocalEventBatch } from './local-commit.js';

interface KyselySqliteStatement {
    readonly reader: boolean;
    all(parameters: ReadonlyArray<unknown>): unknown[];
    run(parameters: ReadonlyArray<unknown>): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
    iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

function wrapStatement(statement: StatementSync, query: string): KyselySqliteStatement {
    const reader = /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b/i.test(query);
    return {
        reader,
        all: (parameters) => statement.all(...parameters as SQLInputValue[]),
        run: (parameters) => statement.run(...parameters as SQLInputValue[]),
        iterate: (parameters) => statement.iterate(...parameters as SQLInputValue[]),
    };
}

function createDatabase(): { database: Kysely<Database>; sqlite: DatabaseSync } {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE raw_events (
            id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            log_id TEXT NOT NULL,
            local_batch_id TEXT NOT NULL,
            local_sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            payload TEXT NOT NULL,
            entity_id TEXT,
            entity_version INTEGER,
            log_version INTEGER,
            sync_state TEXT NOT NULL,
            projection_state TEXT NOT NULL,
            rejection_code TEXT,
            rejection_detail TEXT,
            is_tombstoned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        );
        CREATE TABLE local_batches (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            log_id TEXT NOT NULL,
            status TEXT NOT NULL,
            replacement_for TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE calendar_events (
            tenant_id TEXT NOT NULL,
            log_id TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            event_date TEXT NOT NULL,
            start_time TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            pinned INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        );
    `);
    const adapter = {
        close: () => sqlite.close(),
        prepare: (query: string) => wrapStatement(sqlite.prepare(query), query),
    };
    return {
        database: new Kysely<Database>({
            dialect: new SqliteDialect({ database: adapter }),
        }),
        sqlite,
    };
}

const context: ActiveContext = {
    tenantId: 'tenant-1',
    principalId: 'principal-1',
    logId: 'log-1',
    ledgerOrigin: 'https://ledger.example',
};

function calendarEvent(id = 'calendar-add'): AddCalendarEventEvent {
    return {
        id,
        type: 'CALENDAR_EVENT_ADDED',
        timestamp: 1,
        payload: {
            id: 'calendar-1',
            title: 'Launch',
            eventDate: '2026-07-22',
            startTime: '',
            notes: 'Initial note',
            pinned: false,
        },
    };
}

const openDatabases: Kysely<Database>[] = [];

afterEach(async () => {
    await Promise.all(openDatabases.splice(0).map((database) => database.destroy()));
});

describe('commitLocalEventBatch', () => {
    it('commits the event, batch, and projection in one transaction', async () => {
        const { database, sqlite } = createDatabase();
        openDatabases.push(database);
        const projectCalendar = createEntityProjector(PROJECTION_CONFIGS.calendar_event);

        const result = await commitLocalEventBatch({
            database,
            context,
            events: [calendarEvent('event-1')],
            submissionId: 'submit-1',
            projectEntity: (entityId, tx, scope) =>
                projectCalendar(
                    { payload: { id: 'calendar-1' } },
                    tx,
                    entityId,
                    scope,
                ),
        });

        expect(result.duplicate).toBe(false);
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM raw_events').get()?.count)).toBe(1);
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM local_batches').get()?.count)).toBe(1);
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()?.count)).toBe(1);
        expect(sqlite.prepare('SELECT title, notes FROM calendar_events').get()).toMatchObject({
            title: 'Launch',
            notes: 'Initial note',
        });
    });

    it('projects calendar event add, update, and remove commands', async () => {
        const { database, sqlite } = createDatabase();
        openDatabases.push(database);
        const projectCalendarEvent = createEntityProjector(PROJECTION_CONFIGS.calendar_event);
        const projectEntity = (entityId: string, tx: Parameters<typeof projectCalendarEvent>[1]) =>
            projectCalendarEvent(
                { payload: { id: 'calendar-1' } },
                tx,
                entityId,
                context,
            );

        await commitLocalEventBatch({
            database,
            context,
            events: [calendarEvent()],
            submissionId: 'calendar-add-submit',
            projectEntity,
        });
        expect(sqlite.prepare(`
            SELECT title, event_date, start_time, notes, pinned
            FROM calendar_events
        `).get()).toMatchObject({
            title: 'Launch',
            event_date: '2026-07-22',
            start_time: '',
            notes: 'Initial note',
            pinned: 0,
        });

        const update: UpdateCalendarEventEvent = {
            id: 'calendar-update',
            type: 'CALENDAR_EVENT_UPDATED',
            timestamp: 2,
            payload: {
                id: 'calendar-1',
                title: 'Launch review',
                eventDate: '2026-07-23',
                startTime: '09:30',
                pinned: true,
            },
        };
        await commitLocalEventBatch({
            database,
            context,
            events: [update],
            submissionId: 'calendar-update-submit',
            projectEntity,
        });
        expect(sqlite.prepare(`
            SELECT title, event_date, start_time, notes, pinned
            FROM calendar_events
        `).get()).toMatchObject({
            title: 'Launch review',
            event_date: '2026-07-23',
            start_time: '09:30',
            notes: 'Initial note',
            pinned: 1,
        });

        const remove: RemoveCalendarEventEvent = {
            id: 'calendar-remove',
            type: 'CALENDAR_EVENT_REMOVED',
            timestamp: 3,
            payload: { id: 'calendar-1' },
        };
        await commitLocalEventBatch({
            database,
            context,
            events: [remove],
            submissionId: 'calendar-remove-submit',
            projectEntity,
        });
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()?.count))
            .toBe(0);
    });

    it('rolls back durable events and batches when projection fails', async () => {
        const { database, sqlite } = createDatabase();
        openDatabases.push(database);

        await expect(commitLocalEventBatch({
            database,
            context,
            events: [calendarEvent()],
            submissionId: 'submit-rollback',
            projectEntity: async () => {
                throw new Error('projection failed');
            },
        })).rejects.toThrow('projection failed');

        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM raw_events').get()?.count)).toBe(0);
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM local_batches').get()?.count)).toBe(0);
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()?.count)).toBe(0);
    });

    it('deduplicates a repeated submission before inserting new event IDs', async () => {
        const { database, sqlite } = createDatabase();
        openDatabases.push(database);
        const projectEntity = async () => undefined;

        await commitLocalEventBatch({
            database,
            context,
            events: [calendarEvent('event-first')],
            submissionId: 'stable-submit',
            projectEntity,
        });
        const repeated = await commitLocalEventBatch({
            database,
            context,
            events: [calendarEvent('event-double-click')],
            submissionId: 'stable-submit',
            projectEntity,
        });

        expect(repeated.duplicate).toBe(true);
        expect(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM raw_events').get()?.count)).toBe(1);
    });

    it('marks dynamic definition events for post-commit DDL projection', async () => {
        const { database, sqlite } = createDatabase();
        openDatabases.push(database);
        const event: EntityTypeDefinedEvent = {
            id: 'definition-1',
            type: 'ENTITY_TYPE_DEFINED',
            timestamp: 1,
            payload: {
                id: 'type-1',
                name: 'project',
                displayName: 'Project',
                tableName: 'projects',
                fields: [],
            },
        };

        const result = await commitLocalEventBatch({
            database,
            context,
            events: [event],
            submissionId: 'definition-submit',
            projectEntity: async () => undefined,
        });

        expect(result.pendingDdlEventIds).toEqual(['definition-1']);
        expect(sqlite.prepare('SELECT projection_state FROM raw_events').get()?.projection_state)
            .toBe('pending_ddl');
    });
});
