import { db, requireActiveContext } from '../db/index.js';
import { completeActionBoundary } from './action-boundary.js';
import { isVisibleEventType } from '../event/queries.js';
import { EVENTS_EXCISED, WORKSPACE_RESTORED } from '@hearthlog/contracts/history/replay-selection';
import { sql, type SqlBool } from 'kysely';

export interface HistoryPoint {
    version: number;
    id: string;
    type: string;
    timestamp: number;
    entityId: string | null;
    label: string;
    actionId: string;
    eventCount: number;
}

export interface HistoryActivity {
    id: string;
    label: string;
    timestamp: number;
    version: number | null;
    eventCount: number;
    status: 'ready' | 'waiting' | 'attention';
    reason: string | null;
    point: HistoryPoint | null;
}

type HistoryPointRow = {
    id: string;
    type: string;
    timestamp: number;
    payload: string;
    entity_id: string | null;
    log_version: number | null;
    action_id: string | null;
    action_size: number | null;
};

type HistoryActivityRow = HistoryPointRow & {
    local_sequence: number;
    activity_event_count: number;
    activity_status: HistoryActivity['status'];
    sync_error_message: string | null;
    rejection_code: string | null;
    rejection_detail: string | null;
    projection_state: string;
};

/** List visible log activity, including actions that are not ready to fork. */
export async function listHistoryActivity(): Promise<HistoryActivity[]> {
    const context = await requireActiveContext();
    const visibleTypes = await visibleHistoryTypes(context);
    if (visibleTypes.length === 0) return [];

    const { rows } = await sql<HistoryActivityRow>`
        WITH scoped_activity AS (
            SELECT
                raw_events.id,
                raw_events.type,
                raw_events.timestamp,
                raw_events.payload,
                raw_events.entity_id,
                raw_events.log_version,
                raw_events.action_id,
                raw_events.action_size,
                raw_events.local_sequence,
                raw_events.sync_state,
                raw_events.projection_state,
                raw_events.rejection_code,
                raw_events.rejection_detail,
                COALESCE(raw_events.action_id, raw_events.id) AS activity_group,
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(raw_events.action_id, raw_events.id)
                    ORDER BY raw_events.local_sequence DESC, raw_events.timestamp DESC, raw_events.id DESC
                ) AS activity_rank,
                COUNT(*) OVER (
                    PARTITION BY COALESCE(raw_events.action_id, raw_events.id)
                ) AS activity_event_count,
                MAX(CASE
                    WHEN raw_events.sync_state IN ('conflicted', 'rejected')
                      OR raw_events.projection_state = 'excluded'
                      OR EXISTS (
                          SELECT 1
                          FROM outbox_operation_items AS item
                          JOIN outbox_operations AS operation ON operation.id = item.operation_id
                          WHERE item.event_id = raw_events.id
                            AND operation.status = 'needs_attention'
                      )
                    THEN 1 ELSE 0
                END) OVER (
                    PARTITION BY COALESCE(raw_events.action_id, raw_events.id)
                ) AS has_attention,
                CASE
                    WHEN raw_events.log_version IS NOT NULL
                     AND raw_events.projection_state IN ('effective', 'restored_out')
                     AND ${completeActionBoundary}
                    THEN 1 ELSE 0
                END AS is_forkable,
                (
                    SELECT operation.last_error_message
                    FROM outbox_operation_items AS item
                    JOIN outbox_operations AS operation ON operation.id = item.operation_id
                    WHERE item.event_id = raw_events.id
                      AND operation.status = 'needs_attention'
                    ORDER BY operation.updated_at DESC
                    LIMIT 1
                ) AS sync_error_message
            FROM raw_events
            WHERE raw_events.tenant_id = ${context.tenantId}
              AND raw_events.log_id = ${context.logId}
        ),
        classified_activity AS (
            SELECT *, CASE
                WHEN is_forkable = 1 THEN 'ready'
                WHEN has_attention = 1 THEN 'attention'
                ELSE 'waiting'
            END AS activity_status
            FROM scoped_activity
        )
        SELECT
            activity.id,
            activity.type,
            activity.timestamp,
            activity.payload,
            activity.entity_id,
            activity.log_version,
            activity.action_id,
            activity.action_size,
            activity.local_sequence,
            activity.activity_event_count,
            activity.activity_status,
            activity.sync_error_message,
            activity.rejection_code,
            activity.rejection_detail,
            activity.projection_state
        FROM classified_activity AS activity
        WHERE activity.activity_rank = 1
          AND EXISTS (
              SELECT 1 FROM scoped_activity AS visible_member
              WHERE visible_member.activity_group = activity.activity_group
                AND visible_member.type IN (${sql.join(visibleTypes)})
          )
        ORDER BY COALESCE(activity.log_version, activity.local_sequence) DESC,
                 activity.timestamp DESC,
                 activity.local_sequence DESC,
                 activity.id DESC
    `.execute(db);

    return rows.map((row) => {
        const eventCount = row.action_size ?? row.activity_event_count;
        const point = row.activity_status === 'ready' && row.log_version !== null
            ? toHistoryPoint({ ...row, action_size: eventCount, log_version: row.log_version })
            : null;
        const label = eventCount > 1
            ? `Action (${eventCount} changes)`
            : directiveLabel(row) ?? descriptiveEventLabel(row);
        const reason = row.activity_status === 'ready'
            ? null
            : row.activity_status === 'attention'
                ? row.rejection_detail?.trim() || row.rejection_code?.replace(/_/g, ' ') || row.sync_error_message?.trim() || (row.projection_state === 'excluded'
                    ? 'This event was excluded during sync. Open sync issues to review it.'
                    : 'Resolve this sync issue before forking.')
                : row.log_version !== null
                    ? 'This action is still arriving. Wait for sync to finish before forking.'
                    : 'Waiting to sync. Sync this log before forking.';

        return {
            id: row.id,
            label,
            timestamp: row.timestamp,
            version: row.log_version,
            eventCount,
            status: row.activity_status,
            reason,
            point,
        };
    });
}

export async function listHistoryPoints(limit?: number, search = '', beforeVersion?: number): Promise<HistoryPoint[]> {
    const query = await historyQuery();
    const normalizedSearch = search.trim().toLowerCase();
    let builder = query.where('log_version', 'is not', null);
    if (beforeVersion !== undefined) builder = builder.where('log_version', '<', beforeVersion);
    if (normalizedSearch) {
        // Search accepted action metadata and payload entirely in SQL.
        builder = builder.where(sql<boolean>`instr(
            lower(
                CAST(log_version AS TEXT) || ' ' ||
                CASE
                    WHEN action_size > 1 THEN 'action (' || action_size || ' changes)'
                    ELSE replace(lower(type), '_', ' ')
                END || ' ' ||
                type || ' ' ||
                COALESCE(entity_id, '') || ' ' || payload
            ),
            ${normalizedSearch}
        ) > 0`);
    }
    const ordered = builder.orderBy('log_version', 'desc');
    const rows = limit === undefined
        ? await ordered.execute()
        : await ordered.limit(limit).execute();

    return rows
        .filter((row): row is HistoryPointRow & { log_version: number } => row.log_version !== null)
        .map(toHistoryPoint);
}

export async function getHistoryPoint(version: number): Promise<HistoryPoint | null> {
    const query = await historyQuery();
    const row = await query
        .where('log_version', '=', version)
        .executeTakeFirst();

    return row?.log_version
        ? toHistoryPoint(row as HistoryPointRow & { log_version: number })
        : null;
}

export async function resolveVersionAtOrBefore(timestamp: number): Promise<HistoryPoint | null> {
    const query = await historyQuery();
    const row = await query
        .where('log_version', 'is not', null)
        .where('timestamp', '<=', timestamp)
        .orderBy('log_version', 'desc')
        .executeTakeFirst();

    return row?.log_version
        ? toHistoryPoint(row as HistoryPointRow & { log_version: number })
        : null;
}

/** Nearest selectable point at or before a log version (scrubber seeking). */
export async function getHistoryPointAtOrBefore(version: number): Promise<HistoryPoint | null> {
    const query = await historyQuery();
    const row = await query
        .where('log_version', 'is not', null)
        .where('log_version', '<=', version)
        .orderBy('log_version', 'desc')
        .executeTakeFirst();

    return row?.log_version
        ? toHistoryPoint(row as HistoryPointRow & { log_version: number })
        : null;
}

export async function getAdjacentHistoryPoint(
    currentVersion: number,
    direction: 'previous' | 'next',
): Promise<HistoryPoint | null> {
    const query = await historyQuery();
    const row = await query
        .where('log_version', direction === 'previous' ? '<' : '>', currentVersion)
        .orderBy('log_version', direction === 'previous' ? 'desc' : 'asc')
        .executeTakeFirst();

    return row?.log_version
        ? toHistoryPoint(row as HistoryPointRow & { log_version: number })
        : null;
}

async function historyQuery() {
    const context = await requireActiveContext();
    const visibleTypes = await visibleHistoryTypes(context);
    return db.selectFrom('raw_events')
        .select(['id', 'type', 'timestamp', 'payload', 'entity_id', 'log_version', 'action_id', 'action_size'])
        .where('tenant_id', '=', context.tenantId).where('log_id', '=', context.logId)
        .where('projection_state', 'in', ['effective', 'restored_out'])
        .where(completeActionBoundary)
        // Events hidden by a live excision marker are not selectable history
        // points; the marker itself remains as the audit entry.
        .where(sql<SqlBool>`NOT EXISTS (
            SELECT 1 FROM raw_events AS excision_marker,
                json_each(excision_marker.payload, '$.eventIds') AS excision_target
            WHERE excision_marker.tenant_id = raw_events.tenant_id
              AND excision_marker.log_id = raw_events.log_id
              AND excision_marker.type = ${EVENTS_EXCISED}
              AND excision_marker.projection_state = 'effective'
              AND excision_marker.is_tombstoned = 0
              AND excision_target.value = raw_events.id
        )`)
        .where(eb => eb.or([
            eb('type', 'in', visibleTypes),
            eb.exists(eb.selectFrom('raw_events as visible_member').select('visible_member.id')
                .whereRef('visible_member.tenant_id', '=', 'raw_events.tenant_id')
                .whereRef('visible_member.log_id', '=', 'raw_events.log_id')
                .whereRef('visible_member.action_id', '=', 'raw_events.action_id')
                .where('visible_member.type', 'in', visibleTypes)),
        ]));
}

// Resolve runtime-defined types using the same visibility policy as event views,
// before applying limits or selecting a neighbouring accepted position.
async function visibleHistoryTypes(context: { tenantId: string; logId: string }): Promise<string[]> {
    const types = await db.selectFrom('raw_events').select('type').distinct()
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId).execute();
    return types.map(row => row.type).filter(isVisibleEventType);
}

function toHistoryPoint(row: HistoryPointRow & { log_version: number }): HistoryPoint {
    return {
        version: row.log_version,
        id: row.id,
        type: row.type,
        timestamp: row.timestamp,
        entityId: row.entity_id,
        label: directiveLabel(row) ?? (row.action_size && row.action_size > 1 ? `Action (${row.action_size} changes)` : descriptiveEventLabel(row)),
        actionId: row.action_id ?? row.id,
        eventCount: row.action_size ?? 1,
    };
}

function descriptiveEventLabel(row: HistoryPointRow): string {
    let title: string | undefined;
    try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        title = [payload.description, payload.title, payload.name].find(
            value => typeof value === 'string' && value.trim().length > 0,
        ) as string | undefined;
    } catch {
        return eventLabel(row.type);
    }
    if (!title) return eventLabel(row.type);
    const action = row.type.endsWith('_ADDED') ? 'Added'
        : row.type.endsWith('_UPDATED') ? 'Edited'
        : row.type.endsWith('_DELETED') || row.type.endsWith('_REMOVED') ? 'Removed'
        : null;
    return action ? `${action} ${title}` : eventLabel(row.type);
}

function directiveLabel(row: HistoryPointRow): string | null {
    if (row.type === EVENTS_EXCISED) {
        try {
            const payload = JSON.parse(row.payload) as { eventIds?: unknown };
            const count = Array.isArray(payload.eventIds) ? payload.eventIds.length : 0;
            return count > 0 ? `Removed ${count} event${count === 1 ? '' : 's'}` : 'Removed events';
        } catch {
            return 'Removed events';
        }
    }
    if (row.type === WORKSPACE_RESTORED) {
        try {
            const payload = JSON.parse(row.payload) as { targetVersion?: unknown };
            return typeof payload.targetVersion === 'number' ? `Restored log to v${payload.targetVersion}` : 'Restored log';
        } catch {
            return 'Restored log';
        }
    }
    return null;
}

export function eventLabel(type: string): string {
    return type
        .toLowerCase()
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function formatHistoryDateTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(timestamp));
}
