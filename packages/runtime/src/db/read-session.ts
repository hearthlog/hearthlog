import { sql, type Kysely, type QueryResult, type RawBuilder, type SelectQueryBuilder, type SqlBool } from 'kysely';
import type { EntityTypeDefinitionTable } from './index.js';
import type { EntityDatabaseTables } from '#generated/schema';
import { qualifiedIdentifier } from '../event/projection-builder.js';

export type ReadScope = { tenantId: string; logId: string };
export type ReadView = { effectiveNow: string };

export interface ReadModelDatabase extends EntityDatabaseTables {
    entity_type_definitions: EntityTypeDefinitionTable;
}

/** Read-model queries are always scoped to the selected tenant and log. */
export interface ReadModelSession {
    readonly scope: ReadScope;
    readonly view: ReadView;
    selectFrom<TB extends keyof ReadModelDatabase>(table: TB): SelectQueryBuilder<ReadModelDatabase, TB, {}>;
    table(name: string): RawBuilder<unknown>;
    execute<T>(query: RawBuilder<T>): Promise<QueryResult<T>>;
}

export function createReadModelSession(
    database: Kysely<ReadModelDatabase>,
    options: { schema: string; scope: ReadScope; view: ReadView },
): ReadModelSession {
    const scopedDb = database.withSchema(options.schema);
    const { scope } = options;

    function scopedSelect<TB extends keyof ReadModelDatabase>(table: TB): SelectQueryBuilder<ReadModelDatabase, TB, {}> {
        const scoped = scopedDb.selectFrom(table) as SelectQueryBuilder<ReadModelDatabase, TB, {}>;
        return scoped
            .where(sql<SqlBool>`${sql.ref(`${table}.tenant_id`)} = ${scope.tenantId}`)
            .where(sql<SqlBool>`${sql.ref(`${table}.log_id`)} = ${scope.logId}`);
    }

    return {
        scope,
        view: options.view,
        selectFrom: scopedSelect,
        table(name) {
            return sql`(SELECT * FROM ${sql.raw(qualifiedIdentifier(options.schema, name))} WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId})`;
        },
        execute(query) {
            return query.execute(database);
        },
    };
}
