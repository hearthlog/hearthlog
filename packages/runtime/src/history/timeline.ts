import { db, requireActiveContext } from '../db/index.js';
import { sql } from 'kysely';
import { eventLabel, getAdjacentHistoryPoint, getHistoryPointAtOrBefore, type HistoryPoint } from './history.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';

export interface HistoryBucket {
    bucket: number;
    count: number;
    startVersion: number;
    endVersion: number;
    startTimestamp: number;
    endTimestamp: number;
}

export interface HistoryActivity {
    buckets: HistoryBucket[];
    minVersion: number;
    maxVersion: number;
    maxCount: number;
    firstTimestamp: number;
    lastTimestamp: number;
}

export interface HistoryMarker {
    id: string;
    type: 'restore' | 'excision';
    /** Accepted markers have a version; a pending local marker is legend-only. */
    version: number | null;
    timestamp: number;
    label: string;
    count: number;
    active: boolean;
}

export interface HistoryGhost {
    id: string;
    version: number;
    timestamp: number;
    label: string;
}

/**
 * Density series for the history scrubber. Bucketing and counting happen in
 * SQLite over accepted complete-action boundaries; the UI never loads the log
 * to draw the chart.
 */
export async function loadHistoryActivity(bucketCount = 96): Promise<HistoryActivity | null> {
    const context = await requireActiveContext();
    const buckets = Math.max(8, Math.min(240, Math.floor(bucketCount)));
    const rows = await sql<{
        bucket: number;
        count: number;
        start_version: number;
        end_version: number;
        start_timestamp: number;
        end_timestamp: number;
    }>`
        WITH bounds AS (
            SELECT MIN(log_version) AS min_v, MAX(log_version) AS max_v
            FROM raw_events
            WHERE tenant_id = ${context.tenantId}
              AND log_id = ${context.logId}
              AND log_version IS NOT NULL
              AND projection_state IN ('effective', 'restored_out')
              AND (action_id IS NULL OR action_index = action_size - 1)
        )
        SELECT
            CAST((events.log_version - bounds.min_v) * ${buckets} / (bounds.max_v - bounds.min_v + 1) AS INTEGER) AS bucket,
            COUNT(*) AS count,
            MIN(events.log_version) AS start_version,
            MAX(events.log_version) AS end_version,
            MIN(events.timestamp) AS start_timestamp,
            MAX(events.timestamp) AS end_timestamp
        FROM raw_events events, bounds
        WHERE events.tenant_id = ${context.tenantId}
          AND events.log_id = ${context.logId}
          AND events.log_version IS NOT NULL
          AND events.projection_state IN ('effective', 'restored_out')
          AND (events.action_id IS NULL OR events.action_index = events.action_size - 1)
        GROUP BY bucket
        ORDER BY bucket
    `.execute(db);

    if (rows.rows.length === 0) return null;
    const first = rows.rows[0]!;
    const last = rows.rows[rows.rows.length - 1]!;
    const minVersion = Number(first.start_version);
    const maxVersion = Number(last.end_version);
    const series: HistoryBucket[] = rows.rows.map((row) => ({
        bucket: Number(row.bucket),
        count: Number(row.count),
        startVersion: Number(row.start_version),
        endVersion: Number(row.end_version),
        startTimestamp: Number(row.start_timestamp),
        endTimestamp: Number(row.end_timestamp),
    }));
    return {
        buckets: series,
        minVersion,
        maxVersion,
        maxCount: Math.max(1, ...series.map((bucket) => bucket.count)),
        firstTimestamp: Number(first.start_timestamp),
        lastTimestamp: Number(last.end_timestamp),
    };
}

/** Restore and excision directives, positioned on the same version axis. */
export async function loadHistoryMarkers(): Promise<HistoryMarker[]> {
    const context = await requireActiveContext();
    const rows = await db.selectFrom('raw_events')
        .select(['id', 'type', 'timestamp', 'payload', 'log_version', 'projection_state', 'is_tombstoned'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('type', 'in', [WORKSPACE_RESTORED, EVENTS_EXCISED])
        .where('projection_state', 'in', ['effective', 'restored_out'])
        .orderBy(sql`log_version is null`, 'asc')
        .orderBy('log_version', 'asc')
        .execute();
    return rows.map((row) => {
        let label = row.type === WORKSPACE_RESTORED ? 'Restored log' : 'Removed events';
        let count = 1;
        try {
            const payload = JSON.parse(row.payload) as { targetVersion?: unknown; eventIds?: unknown };
            if (row.type === WORKSPACE_RESTORED && typeof payload.targetVersion === 'number') {
                label = `Restored log to v${payload.targetVersion}`;
            }
            if (row.type === EVENTS_EXCISED && Array.isArray(payload.eventIds)) {
                count = payload.eventIds.length;
                label = `Removed ${count} event${count === 1 ? '' : 's'}`;
            }
        } catch {
            // Keep the fallback label for a malformed marker.
        }
        return {
            id: row.id,
            type: row.type === WORKSPACE_RESTORED ? 'restore' as const : 'excision' as const,
            version: row.log_version ?? null,
            timestamp: row.timestamp,
            label,
            count,
            active: row.projection_state === 'effective' && row.is_tombstoned === 0,
        };
    });
}

/** Events hidden by a live excision, drawn as hollow ticks under the density. */
export async function loadHistoryGhosts(limit = 300): Promise<HistoryGhost[]> {
    const context = await requireActiveContext();
    const markers = await db.selectFrom('raw_events')
        .select('payload')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('type', '=', EVENTS_EXCISED)
        .where('projection_state', '=', 'effective')
        .where('is_tombstoned', '=', 0)
        .execute();
    const ids = new Set<string>();
    for (const marker of markers) {
        try {
            const payload = JSON.parse(marker.payload) as { eventIds?: unknown };
            if (Array.isArray(payload.eventIds)) {
                for (const id of payload.eventIds) {
                    if (typeof id === 'string') ids.add(id);
                }
            }
        } catch {
            // A malformed marker contributes no ghosts.
        }
    }
    if (ids.size === 0) return [];
    const rows = await db.selectFrom('raw_events')
        .select(['id', 'type', 'timestamp', 'log_version'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('id', 'in', [...ids])
        .where('log_version', 'is not', null)
        .orderBy('log_version', 'asc')
        .limit(limit)
        .execute();
    return rows.map((row) => ({
        id: row.id,
        version: row.log_version!,
        timestamp: row.timestamp,
        label: eventLabel(row.type),
    }));
}

/** Snap a free timeline position to the nearest selectable action boundary. */
export async function resolveNearestHistoryPoint(version: number): Promise<HistoryPoint | null> {
    const [before, after] = await Promise.all([
        getHistoryPointAtOrBefore(version),
        getAdjacentHistoryPoint(version, 'next'),
    ]);
    if (!before) return after;
    if (!after) return before;
    return Math.abs(before.version - version) <= Math.abs(after.version - version) ? before : after;
}

/** The nearest bucket for a free position, used by the scrubber tooltip. */
export function nearestBucket(activity: HistoryActivity, version: number): HistoryBucket | null {
    let best: HistoryBucket | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const bucket of activity.buckets) {
        const distance = version < bucket.startVersion
            ? bucket.startVersion - version
            : version > bucket.endVersion
                ? version - bucket.endVersion
                : 0;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = bucket;
        }
    }
    return best;
}
