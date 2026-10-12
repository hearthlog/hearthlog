import { sql, type Kysely } from 'kysely';
import { db, type Database } from './index.js';
import { tenant } from '@hearthlog/contracts/tenant/config';

export const RAW_SQLITE_PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_RAW_SQLITE_PAGE_SIZE = 50;

export type RawSqlitePageSize = (typeof RAW_SQLITE_PAGE_SIZES)[number];
export type RawSqliteSortDirection = 'asc' | 'desc';

export interface RawSqliteExecutor {
    query<Row extends Record<string, unknown>>(statement: string): Promise<Row[]>;
}

export interface RawSqliteTable {
    name: string;
}

export interface RawSqliteColumn {
    name: string;
    dataType: string;
    notNull: boolean;
    defaultValue: unknown;
    primaryKeyPosition: number;
}

export interface RawSqliteTablePage {
    tables: RawSqliteTable[];
    tableName: string | null;
    columns: RawSqliteColumn[];
    rows: Record<string, unknown>[];
    totalRows: number;
    currentPage: number;
    pageSize: RawSqlitePageSize;
    totalPages: number;
    sortField: string | null;
    sortDirection: RawSqliteSortDirection;
}

export type RawSqliteValuePresentation = {
    kind: 'null' | 'blob' | 'scalar';
    text: string;
};

type SqliteTableRow = {
    name: string;
};

type SqliteColumnRow = {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
};

type ActiveScope = {
    tenantId: string;
    logId: string;
};

const localExecutor = createKyselyRawSqliteExecutor(db);

export function createKyselyRawSqliteExecutor(
    database: Kysely<Database>,
): RawSqliteExecutor {
    return {
        async query<Row extends Record<string, unknown>>(
            statement: string,
        ): Promise<Row[]> {
            const result = await sql.raw<Row>(statement).execute(database);
            return [...result.rows];
        },
    };
}

export function quoteRawSqliteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

export function parseRawSqlitePage(value: string | number | null | undefined): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function parseRawSqlitePageSize(
    value: string | number | null | undefined,
): RawSqlitePageSize {
    const parsed = Number(value);
    return RAW_SQLITE_PAGE_SIZES.includes(parsed as RawSqlitePageSize)
        ? (parsed as RawSqlitePageSize)
        : DEFAULT_RAW_SQLITE_PAGE_SIZE;
}

export function parseRawSqliteSortDirection(
    value: string | number | null | undefined,
): RawSqliteSortDirection {
    return String(value).toLowerCase() === 'desc' ? 'desc' : 'asc';
}

export function parseRawSqliteSortField(
    value: string | number | null | undefined,
    columns?: ReadonlyArray<Pick<RawSqliteColumn, 'name'>> | null,
): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return null;
    if (columns && !columns.some((column) => column.name === trimmed)) {
        return null;
    }
    return trimmed;
}

export async function listRawSqliteTables(
    executor: RawSqliteExecutor = localExecutor,
    allowedTableNames?: ReadonlySet<string>,
): Promise<RawSqliteTable[]> {
    const rows = await executor.query<SqliteTableRow>(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name COLLATE NOCASE, name
    `);

    const visibleTableNames = allowedTableNames
        ?? await tenantVisibleTableNames(executor);
    return rows
        .filter(({ name }) => visibleTableNames.has(name))
        .map(({ name }) => ({ name }));
}

export async function loadRawSqliteTablePage(
    input: {
        tableName?: string | null;
        page?: string | number | null;
        pageSize?: string | number | null;
        sort?: string | null;
        direction?: string | number | null;
    },
    executor: RawSqliteExecutor = localExecutor,
    allowedTableNames?: ReadonlySet<string>,
): Promise<RawSqliteTablePage> {
    const tables = await listRawSqliteTables(executor, allowedTableNames);
    const selectedTable = tables.find((table) => table.name === input.tableName)
        ?? tables[0]
        ?? null;
    const pageSize = parseRawSqlitePageSize(input.pageSize);

    if (!selectedTable) {
        return {
            tables,
            tableName: null,
            columns: [],
            rows: [],
            totalRows: 0,
            currentPage: 1,
            pageSize,
            totalPages: 1,
            sortField: null,
            sortDirection: 'asc',
        };
    }

    const tablePage = await readRawSqliteTablePage(
        {
            tableName: selectedTable.name,
            page: input.page,
            pageSize,
            sort: input.sort,
            direction: input.direction,
        },
        executor,
        tables,
        allowedTableNames,
    );

    return {
        tables,
        ...tablePage,
    };
}

export async function readRawSqliteTablePage(
    input: {
        tableName: string;
        page?: string | number | null;
        pageSize?: string | number | null;
        sort?: string | null;
        direction?: string | number | null;
    },
    executor: RawSqliteExecutor = localExecutor,
    knownTables?: RawSqliteTable[],
    allowedTableNames?: ReadonlySet<string>,
): Promise<Omit<RawSqliteTablePage, 'tables'>> {
    const visibleTableNames = allowedTableNames
        ?? await tenantVisibleTableNames(executor);
    const tables = (knownTables ?? await listRawSqliteTables(executor, visibleTableNames))
        .filter(({ name }) => visibleTableNames.has(name));
    if (!tables.some((table) => table.name === input.tableName)) {
        throw new Error(`Unknown local SQLite table "${input.tableName}"`);
    }

    const tableIdentifier = quoteRawSqliteIdentifier(input.tableName);
    const columnRows = await executor.query<SqliteColumnRow>(
        `PRAGMA table_info(${tableIdentifier})`,
    );
    const columns = columnRows
        .sort((left, right) => Number(left.cid) - Number(right.cid))
        .map((column) => ({
            name: column.name,
            dataType: column.type || 'ANY',
            notNull: Boolean(column.notnull),
            defaultValue: column.dflt_value,
            primaryKeyPosition: Number(column.pk),
        }));

    const scope = await activeScope(executor);
    const isScoped = columns.some((column) => column.name === 'tenant_id')
        && columns.some((column) => column.name === 'log_id');
    if (isScoped && !scope) {
        throw new Error('No active tenant context is available for this table.');
    }
    const where = isScoped
        ? ` WHERE ${quoteRawSqliteIdentifier('tenant_id')} = ${quoteRawSqliteLiteral(scope!.tenantId)}\n` +
            `  AND ${quoteRawSqliteIdentifier('log_id')} = ${quoteRawSqliteLiteral(scope!.logId)}`
        : '';

    const countRows = await executor.query<{ count: number | bigint | string }>(
        `SELECT COUNT(*) AS count FROM ${tableIdentifier}${where}`,
    );
    const totalRows = Number(countRows[0]?.count ?? 0);
    const pageSize = parseRawSqlitePageSize(input.pageSize);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(parseRawSqlitePage(input.page), totalPages);
    const offset = (currentPage - 1) * pageSize;
    const sortField = parseRawSqliteSortField(input.sort, columns);
    const sortDirection = parseRawSqliteSortDirection(input.direction);
    const primaryKeyColumns = columns
        .filter((column) => column.primaryKeyPosition > 0)
        .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
    const orderByParts: string[] = [];
    if (sortField) {
        orderByParts.push(`${quoteRawSqliteIdentifier(sortField)} ${sortDirection.toUpperCase()}`);
    }
    const defaultOrderBy = primaryKeyColumns.length > 0
        ? primaryKeyColumns
            .map((column) => `${quoteRawSqliteIdentifier(column.name)} ASC`)
            .join(', ')
        : '_rowid_ ASC';
    // The sort column doubles as the tiebreak when it is unique-ish, but a
    // stable PK/_rowid_ tiebreak keeps pagination deterministic for duplicate
    // values (e.g. many rows sharing the same amount or status).
    if (!sortField || !defaultOrderBy.startsWith(`${quoteRawSqliteIdentifier(sortField)} `)) {
        orderByParts.push(defaultOrderBy);
    }
    const orderBy = orderByParts.join(', ');
    const rows = await executor.query<Record<string, unknown>>(`
        SELECT *
        FROM ${tableIdentifier}
        ${where}
        ORDER BY ${orderBy}
        LIMIT ${pageSize}
        OFFSET ${offset}
    `);

    return {
        tableName: input.tableName,
        columns,
        rows,
        totalRows,
        currentPage,
        pageSize,
        totalPages,
        sortField,
        sortDirection,
    };
}

async function tenantVisibleTableNames(
    executor: RawSqliteExecutor,
): Promise<ReadonlySet<string>> {
    const visible = new Set(tenant.approvedEntities.tables);
    if (!tenant.dynamicEntities) return visible;

    const scope = await activeScope(executor);
    if (!scope) return visible;
    try {
        const rows = await executor.query<{ table_name: string }>(`
            SELECT table_name
            FROM "entity_type_definitions"
            WHERE tenant_id = ${quoteRawSqliteLiteral(scope.tenantId)}
              AND log_id = ${quoteRawSqliteLiteral(scope.logId)}
              AND is_archived = 0
        `);
        for (const row of rows) visible.add(row.table_name);
    } catch {
        // A legacy/incomplete database may not have dynamic definitions yet.
        // Static approved tables remain available in that case.
    }
    return visible;
}

async function activeScope(executor: RawSqliteExecutor): Promise<ActiveScope | null> {
    try {
        const rows = await executor.query<{ tenant_id: string; log_id: string }>(`
            SELECT tenant_id, log_id
            FROM "active_context"
            WHERE id = 1
            LIMIT 1
        `);
        const row = rows[0];
        if (!row?.tenant_id || !row.log_id) return null;
        return { tenantId: row.tenant_id, logId: row.log_id };
    } catch {
        return null;
    }
}

export function quoteRawSqliteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function presentRawSqliteValue(value: unknown): RawSqliteValuePresentation {
    if (value === null || value === undefined) {
        return { kind: 'null', text: 'NULL' };
    }

    if (value instanceof ArrayBuffer) {
        return { kind: 'blob', text: formatBlobSize(value.byteLength) };
    }

    if (ArrayBuffer.isView(value)) {
        return { kind: 'blob', text: formatBlobSize(value.byteLength) };
    }

    if (typeof value === 'string') {
        return { kind: 'scalar', text: value };
    }

    if (
        typeof value === 'number'
        || typeof value === 'bigint'
        || typeof value === 'boolean'
    ) {
        return { kind: 'scalar', text: String(value) };
    }

    try {
        return {
            kind: 'scalar',
            text: JSON.stringify(value) ?? String(value),
        };
    } catch {
        return { kind: 'scalar', text: String(value) };
    }
}

function formatBlobSize(byteLength: number): string {
    return `<BLOB ${byteLength} ${byteLength === 1 ? 'byte' : 'bytes'}>`;
}
