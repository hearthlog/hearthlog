import { db } from './index.js';
import { createKyselyRawSqliteExecutor, type RawSqliteExecutor } from './raw-browser.js';

export interface LocalSqliteStats {
    allocatedBytes: number;
    occupiedBytes: number;
    reusableBytes: number;
    pageSize: number;
    pageCount: number;
    freePageCount: number;
    schemaVersion: number;
    sqliteVersion: string;
    tableCount: number;
    indexCount: number;
    activeLog: {
        eventCount: number;
        pendingOperationCount: number;
    } | null;
}

const localExecutor = createKyselyRawSqliteExecutor(db);

/** File-wide page figures and SQL-scoped counts for the selected tenant/log. */
export async function loadLocalSqliteStats(
    executor: RawSqliteExecutor = localExecutor,
): Promise<LocalSqliteStats> {
    // SQLocal labels a bare `PRAGMA page_size` result with its value (for
    // example "8192"), so use SQLite's table-valued read-only PRAGMAs.
    const rows = await executor.query<{
        page_count: number | string;
        page_size: number | string;
        freelist_count: number | string;
        user_version: number | string;
        sqlite_version: string;
        tables: number | string;
        indexes: number | string;
    }>(`
        SELECT sqlite_version() AS sqlite_version, pages.page_count, sizes.page_size, free.freelist_count, versions.user_version,
            (SELECT COUNT(*) FROM sqlite_schema
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
            (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index') AS indexes
        FROM pragma_page_count AS pages
        CROSS JOIN pragma_page_size AS sizes
        CROSS JOIN pragma_freelist_count AS free
        CROSS JOIN pragma_user_version AS versions
    `);

    const pageCount = Number(rows[0]?.page_count ?? 0);
    const pageSize = Number(rows[0]?.page_size ?? 0);
    const freePageCount = Number(rows[0]?.freelist_count ?? 0);
    const allocatedBytes = pageCount * pageSize;
    const reusableBytes = freePageCount * pageSize;

    let activeLog: LocalSqliteStats['activeLog'] = null;
    try {
        const rows = await executor.query<{
            event_count: number;
            pending_operation_count: number;
        }>(`
            SELECT
                (SELECT COUNT(*) FROM raw_events AS events
                    WHERE events.tenant_id = context.tenant_id
                      AND events.log_id = context.log_id) AS event_count,
                (SELECT COUNT(*) FROM outbox_operations AS operations
                    WHERE operations.tenant_id = context.tenant_id
                      AND operations.log_id = context.log_id
                      AND operations.status IN ('pending', 'syncing', 'failed', 'needs_attention')) AS pending_operation_count
            FROM active_context AS context
            WHERE context.id = 1
        `);
        if (rows[0]) {
            activeLog = {
                eventCount: Number(rows[0].event_count),
                pendingOperationCount: Number(rows[0].pending_operation_count),
            };
        }
    } catch {
        // The file remains inspectable before a log is selected or migration finishes.
    }

    return {
        allocatedBytes,
        occupiedBytes: Math.max(0, allocatedBytes - reusableBytes),
        reusableBytes,
        pageSize,
        pageCount,
        freePageCount,
        schemaVersion: Number(rows[0]?.user_version ?? 0),
        sqliteVersion: String(rows[0]?.sqlite_version ?? 'unknown'),
        tableCount: Number(rows[0]?.tables ?? 0),
        indexCount: Number(rows[0]?.indexes ?? 0),
        activeLog,
    };
}

export function formatSqliteBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
