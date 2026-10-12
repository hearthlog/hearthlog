import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from '../db/index.js';
import { getEntityDDLForTables } from '#generated/schema';
import { buildBulkProjectionSQL, projectEntitySet, PROJECTION_CONFIGS } from '../event/projection-builder.js';

export type TestScope = { tenantId: string; logId: string };

export interface TestEvent {
    id: string;
    type: string;
    timestamp: number;
    payload: Record<string, unknown>;
    entityId: string | null;
    entityVersion: number | null;
    logVersion: number | null;
    sequence?: number;
    syncState?: 'pending' | 'synced';
    projectionState?: 'effective' | 'rejected';
    tombstoned?: boolean;
}

/**
 * An in-memory database for projection tests: `raw_events`, the read-model tables of the entities
 * named, and optionally a copy of those tables in a `history` schema. No browser globals.
 * Modules reach it through `@hearthlog/sdk/testing`; it never exposes the app's database type.
 */
export function createProjectionTestDatabase(options: { tables: readonly string[]; scope?: TestScope; history?: boolean }) {
    const scope = options.scope ?? { tenantId: 'tenant-1', logId: 'log-1' };
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE raw_events (
            id TEXT NOT NULL, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
            local_batch_id TEXT NOT NULL, local_sequence INTEGER NOT NULL,
            type TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
            entity_id TEXT, entity_version INTEGER, log_version INTEGER,
            sync_state TEXT NOT NULL, projection_state TEXT NOT NULL,
            rejection_code TEXT, rejection_detail TEXT, is_tombstoned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, log_id, id)
        );
    `);
    for (const ddl of getEntityDDLForTables(new Set(options.tables))) sqlite.exec(ddl);
    if (options.history) {
        sqlite.exec(`ATTACH DATABASE ':memory:' AS history;`);
        for (const table of options.tables) sqlite.exec(`CREATE TABLE history."${table}" AS SELECT * FROM main."${table}" WHERE 0;`);
    }
    const database = new Kysely<Database>({
        dialect: new SqliteDialect({
            database: {
                close: () => sqlite.close(),
                prepare(query: string) {
                    const statement = sqlite.prepare(query);
                    return {
                        reader: /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b/i.test(query),
                        all: (parameters: ReadonlyArray<unknown>) => statement.all(...(parameters as SQLInputValue[])),
                        run: (parameters: ReadonlyArray<unknown>) => statement.run(...(parameters as SQLInputValue[])),
                        iterate: (parameters: ReadonlyArray<unknown>) => statement.iterate(...(parameters as SQLInputValue[])),
                    };
                },
            },
        }),
    });
    const insert = sqlite.prepare(`
        INSERT INTO raw_events (
            id, tenant_id, log_id, local_batch_id, local_sequence, type, timestamp,
            payload, entity_id, entity_version, log_version, sync_state, projection_state, is_tombstoned
        ) VALUES (?, ?, ?, 'batch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let sequence = 0;
    const config = (entity: string) => {
        const found = PROJECTION_CONFIGS[entity];
        if (!found) throw new Error(`No projection config for entity "${entity}"`);
        return found;
    };
    return {
        scope,
        sqlite,
        /** Appends one event to `raw_events` (accepted and effective unless said otherwise). */
        addEvent(event: TestEvent): void {
            sequence += 1;
            insert.run(
                event.id, scope.tenantId, scope.logId, event.sequence ?? sequence, event.type, event.timestamp,
                JSON.stringify(event.payload), event.entityId, event.entityVersion, event.logVersion,
                event.syncState ?? 'synced', event.projectionState ?? 'effective', event.tombstoned ? 1 : 0,
            );
        },
        /** Projects the given entities from `raw_events` into their read-model tables. */
        async project(entity: string, entityIds: string[]): Promise<void> {
            await database.transaction().execute((tx) => projectEntitySet(config(entity), entityIds, tx, scope));
        },
        /** Rebuilds one entity's table from every event, optionally as of a log version into `history`. */
        async rebuild(entity: string, boundary?: { version: number; schema: 'history' }): Promise<void> {
            const query = boundary
                ? buildBulkProjectionSQL(config(entity), scope, { boundary: { kind: 'log-version', version: boundary.version }, target: { schema: boundary.schema } })
                : buildBulkProjectionSQL(config(entity), scope);
            await query.execute(database);
        },
        async destroy(): Promise<void> {
            await database.destroy();
        },
    };
}

export type ProjectionTestDatabase = ReturnType<typeof createProjectionTestDatabase>;
