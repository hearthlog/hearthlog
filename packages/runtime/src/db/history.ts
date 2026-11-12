import { sql, type RawBuilder } from 'kysely';
import type { ReadModelSession } from './read-session.js';
import { ENTITY_DEFINITIONS } from '@hearthlog/contracts/event/entity-definitions';
import { FEATURES } from '@hearthlog/contracts/features/registry';
import type {
    ForkReview,
    HistoryCursor,
    HistoryEntry,
    HistoryFold,
    HistoryItem,
    HistoryListOptions,
    HistoryLocation,
    HistoryPoint,
    HistoryRecord,
    HistoryTimelineOptions,
    HistoryTimelinePage,
    HistoryTimelineRow,
} from '../history/contracts.js';
import {
    ensureHistoryIndex,
    historyEventLabel,
    historyFeatureLabels,
    historyMetadata,
    type SqlRunner,
} from '../history/action-index.js';
import { withTimeout } from '../utils/async.js';

/** Every feature an action can belong to, plus '~' for events of no feature (see `features` in the index). */
const featureKeys = sql.join([...new Set(['~', ...FEATURES.map((feature) => feature.id), ...ENTITY_DEFINITIONS.map((entity) => entity.feature)])]
    .map((feature) => sql`(${feature})`));
const order = sql`action.pending DESC, action.position DESC, action.id DESC`;
/** The newest actions always list one by one; older history folds into months once the log holds more than this. */
const UNFOLDED_ACTIONS = 300;
const UNFOLDED_DAYS = 14;
/** At most this many points on the log map; a busier span draws slices of time instead. */
const MAP_POINTS = 400;
const MAP_SLICES = 240;

/** Rows at or after a cursor (`>=`), or strictly after it in list order (`<`, the next page). */
function cursorFilter(cursor: HistoryCursor, inclusive: boolean): RawBuilder<unknown> {
    return inclusive
        ? sql`(action.pending > ${cursor.pending} OR (action.pending = ${cursor.pending} AND action.run_start >= ${cursor.run}))`
        : sql`(action.pending < ${cursor.pending} OR (action.pending = ${cursor.pending} AND action.run_start < ${cursor.run}))`;
}

function startOfDay(timestamp: number): number {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Log history reads. Actions come from the action index (`history/action-index.ts`), built on first use and kept
 * current as events change, so a page costs what it shows. Whether an action needs attention is read live from the
 * outbox, which can change without its events changing.
 */
export function createHistoryRepository(session: ReadModelSession) {
    const { tenantId, logId } = session.scope;
    const run: SqlRunner = (query) => session.execute(query);
    const scoped = sql`action.tenant_id = ${tenantId} AND action.log_id = ${logId}`;
    // Actions with an operation that failed for good; there are few, whatever the size of the log.
    const blocked = sql`blocked AS (
        SELECT COALESCE(event.action_id, event.id) AS group_id, MAX(operation.last_error_message) AS message
        FROM outbox_operations AS operation
        JOIN outbox_operation_items AS item ON item.operation_id = operation.id
        JOIN main.raw_events AS event ON event.tenant_id = operation.tenant_id AND event.log_id = operation.log_id
            AND event.id = item.event_id
        WHERE operation.tenant_id = ${tenantId} AND operation.log_id = ${logId}
          AND operation.status = 'needs_attention' AND operation.last_error_message IS NOT NULL
        GROUP BY 1)`;
    const attention = sql`(action.settled_attention = 1 OR blocked.message IS NOT NULL)`;
    const entry = sql`action.id, action.type, action.timestamp, action.version, action.local_sequence, action.feature,
        action.actor, action.event_count AS eventCount, action.label, action.pending, action.position,
        COALESCE(action.first_version - 1, 0) AS previousVersion,
        CASE WHEN ${attention} THEN 'attention' WHEN action.complete = 1 THEN 'ready' ELSE 'waiting' END AS status,
        CASE WHEN ${attention} THEN COALESCE(CASE WHEN action.issue IS NULL THEN blocked.message
                WHEN blocked.message IS NULL OR action.issue > blocked.message THEN action.issue ELSE blocked.message END,
                'Open sync issues to review this action.')
            WHEN action.complete = 1 THEN NULL
            WHEN action.version IS NULL THEN 'Saved on this device. Waiting to sync.'
            ELSE 'This action is still arriving. Wait for sync to finish.' END AS reason`;
    const actions = sql`main.history_actions AS action LEFT JOIN blocked ON blocked.group_id = action.group_id`;

    async function execute<T>(query: RawBuilder<T>) {
        // Building a log's index the first time is not part of the read's time limit.
        await ensureHistoryIndex(run, session.scope);
        return withTimeout(session.execute(query), 15_000, 'History could not be loaded. Try again.');
    }

    function listFilter(options: HistoryListOptions & Pick<HistoryTimelineOptions, 'since' | 'until'>, search: string, feature: string): RawBuilder<unknown> {
        const filters = [scoped, sql`action.visible = 1`];
        if (options.since != null) filters.push(sql`action.timestamp >= ${options.since}`);
        if (options.until != null) filters.push(sql`action.timestamp < ${options.until}`);
        if (feature) filters.push(sql`instr(action.features, ${`,${feature},`}) > 0`);
        if (search) {
            filters.push(options.searchValues
                ? sql`(instr(action.search_text, ${search}) > 0 OR EXISTS (
                    SELECT 1 FROM main.raw_events AS member WHERE member.tenant_id = action.tenant_id AND member.log_id = action.log_id
                      AND (member.action_id = action.group_id OR (member.action_id IS NULL AND member.id = action.group_id))
                      AND instr(lower(member.payload), ${search}) > 0))`
                : sql`instr(action.search_text, ${search}) > 0`);
        }
        if (options.eventIds) {
            filters.push(sql`action.group_id IN (SELECT DISTINCT COALESCE(action_id, id) FROM main.raw_events
                WHERE tenant_id = ${tenantId} AND log_id = ${logId}
                  AND id IN (SELECT value FROM json_each(${JSON.stringify(options.eventIds)})))`);
        }
        return sql.join(filters, sql` AND `);
    }

    /** How many listed actions come before this one, or null when it is not in the list. */
    async function actionsAhead(where: RawBuilder<unknown>, id: string): Promise<number | null> {
        const { rows } = await execute<{ ahead: number | null }>(sql`
            SELECT (SELECT COUNT(*) FROM main.history_actions AS action WHERE ${where}
                AND (action.pending > target.pending OR (action.pending = target.pending AND (action.position > target.position
                    OR (action.position = target.position AND action.id > target.id))))) AS ahead
            FROM main.history_actions AS target
            WHERE target.tenant_id = ${tenantId} AND target.log_id = ${logId} AND target.id = ${id}`);
        return rows[0]?.ahead ?? null;
    }

    function timelineFilter(options: HistoryTimelineOptions): RawBuilder<unknown> {
        const { search, feature, searchValues, since, until } = options;
        return listFilter({ searchValues, since, until }, search?.trim().toLowerCase() ?? '', feature ?? '');
    }

    type TimelineSqlRow = Omit<HistoryTimelineRow, 'copied'> & { copied: number };
    function timelineRows(rows: TimelineSqlRow[]): HistoryTimelineRow[] {
        return rows.map((row) => ({ ...row, kind: 'action', copied: Boolean(row.copied), startsDay: false, total: 0 }));
    }
    const copied = (sourceVersion: number | null | undefined) =>
        sql`CASE WHEN action.version IS NOT NULL AND action.version <= ${sourceVersion ?? -1} THEN 1 ELSE 0 END AS copied`;

    return {
        /**
         * One page of the timeline, newest first, a burst of similar actions as one row (its newest action). Pages by
         * cursor through the index in burst order, so a page costs what it shows wherever it is in the log.
         */
        async timeline(options: HistoryTimelineOptions = {}): Promise<HistoryTimelinePage> {
            const limit = Math.max(1, options.limit ?? 60);
            const filters = [timelineFilter(options)];
            if (options.before) filters.push(cursorFilter(options.before, false));
            if (options.through) filters.push(cursorFilter(options.through, true));
            const where = sql.join(filters, sql` AND `);
            const take = options.through ? 100_000 : limit + 1;
            const { rows } = await execute<TimelineSqlRow>(sql`
                WITH ${blocked},
                runs AS (
                    SELECT action.pending AS run_pending, action.run_start AS run, COUNT(*) AS run_count,
                        MAX(action.position) AS top_position, MIN(action.timestamp) AS run_from
                    FROM main.history_actions AS action WHERE ${where}
                    GROUP BY action.pending, action.run_start
                    ORDER BY action.pending DESC, action.run_start DESC LIMIT ${take}
                )
                SELECT ${entry}, ${copied(options.sourceVersion)}, runs.run AS runStart, runs.run_count AS runCount,
                    runs.run_from AS runFrom
                FROM runs
                JOIN main.history_actions AS action ON ${scoped} AND action.visible = 1
                    AND action.pending = runs.run_pending AND action.position = runs.top_position
                LEFT JOIN blocked ON blocked.group_id = action.group_id
                ORDER BY runs.run_pending DESC, runs.run DESC`);
            const page = timelineRows(rows);
            if (options.through) {
                const last = page.at(-1);
                return { rows: page, next: last ? { pending: last.pending, run: last.runStart } : null };
            }
            const more = page.length > limit;
            if (more) page.length = limit;
            const last = page.at(-1);
            return { rows: page, next: more && last ? { pending: last.pending, run: last.runStart } : null };
        },
        /** The actions of one burst, newest first; `before` is the position to continue below. */
        async members(run: HistoryCursor, options: HistoryTimelineOptions & { beforePosition?: number | null } = {}): Promise<{ rows: HistoryTimelineRow[]; next: number | null }> {
            const limit = Math.max(1, options.limit ?? 60);
            const { rows } = await execute<TimelineSqlRow>(sql`WITH ${blocked}
                SELECT ${entry}, ${copied(options.sourceVersion)}, action.run_start AS runStart, 1 AS runCount, action.timestamp AS runFrom
                FROM ${actions}
                WHERE ${timelineFilter(options)} AND action.pending = ${run.pending} AND action.run_start = ${run.run}
                  ${options.beforePosition != null ? sql`AND action.position < ${options.beforePosition}` : sql``}
                ORDER BY action.position DESC LIMIT ${limit + 1}`);
            const page = timelineRows(rows);
            const more = page.length > limit;
            if (more) page.length = limit;
            const last = rows[Math.min(rows.length, limit) - 1] as (TimelineSqlRow & { position: number }) | undefined;
            return { rows: page, next: more && last ? last.position : null };
        },
        /** How many listed actions lie below a row; unchanged unless older history itself changed. */
        async countBelow(cursor: HistoryCursor, options: HistoryTimelineOptions = {}): Promise<number> {
            const { rows } = await execute<{ count: number }>(sql`SELECT COUNT(*) AS count FROM main.history_actions AS action
                WHERE ${timelineFilter(options)} AND ${cursorFilter(cursor, false)}`);
            return Number(rows[0]?.count ?? 0);
        },
        /**
         * Where older history starts folding into months: before the newest ${UNFOLDED_DAYS} days and the newest
         * ${UNFOLDED_ACTIONS} actions, whichever reaches further back. Null while the log is small enough to list whole.
         */
        async foldStart(): Promise<number | null> {
            const { rows } = await execute<{ total: number; newest: number | null; nth: number | null }>(sql`
                SELECT (SELECT COUNT(*) FROM main.history_actions AS action WHERE ${scoped} AND action.visible = 1) AS total,
                    (SELECT MAX(action.timestamp) FROM main.history_actions AS action WHERE ${scoped} AND action.visible = 1) AS newest,
                    (SELECT action.timestamp FROM main.history_actions AS action WHERE ${scoped} AND action.visible = 1
                        ORDER BY action.timestamp DESC LIMIT 1 OFFSET ${UNFOLDED_ACTIONS - 1}) AS nth`);
            const row = rows[0];
            if (!row || Number(row.total) <= UNFOLDED_ACTIONS + 100 || row.newest === null || row.nth === null) return null;
            const recent = new Date(row.newest);
            recent.setDate(recent.getDate() - (UNFOLDED_DAYS - 1));
            return Math.min(startOfDay(recent.getTime()), startOfDay(row.nth));
        },
        /** Older history by month, or by day within a span, newest first, aggregated from the index. */
        async folds(unit: 'month' | 'day', span: { since?: number | null; until: number }): Promise<HistoryFold[]> {
            const format = unit === 'month' ? '%Y-%m' : '%Y-%m-%d';
            const { rows } = await execute<{ key: string; count: number; from: number; to: number; features: string;
                firstVersion: number | null; lastVersion: number | null }>(sql`
                WITH grouped AS (
                    SELECT strftime(${format}, action.timestamp / 1000, 'unixepoch', 'localtime') AS key, action.feature,
                        COUNT(*) AS count, MIN(action.timestamp) AS first_at, MAX(action.timestamp) AS last_at,
                        MIN(action.first_version) AS first_version, MAX(action.version) AS last_version
                    FROM main.history_actions AS action
                    WHERE ${scoped} AND action.visible = 1 AND action.timestamp < ${span.until}
                      ${span.since != null ? sql`AND action.timestamp >= ${span.since}` : sql``}
                    GROUP BY 1, 2
                )
                SELECT key, SUM(count) AS count, MIN(first_at) AS "from", MAX(last_at) AS "to",
                    MIN(first_version) AS firstVersion, MAX(last_version) AS lastVersion,
                    (SELECT json_group_array(feature) FROM (SELECT feature FROM grouped AS inner_group
                        WHERE inner_group.key = grouped.key AND feature IS NOT NULL ORDER BY count DESC, feature LIMIT 4)) AS features
                FROM grouped GROUP BY key ORDER BY key DESC`);
            return rows.map((row) => ({ ...row, count: Number(row.count), features: JSON.parse(row.features) as string[] }));
        },
        /** Where an action sits, to bring it into view. */
        async locate(id: string): Promise<HistoryLocation | null> {
            const { rows } = await execute<HistoryLocation>(sql`
                SELECT action.id, action.timestamp, action.pending, action.run_start AS runStart,
                    (SELECT top.id FROM main.history_actions AS top WHERE top.tenant_id = action.tenant_id
                        AND top.log_id = action.log_id AND top.visible = 1 AND top.pending = action.pending
                        AND top.run_start = action.run_start ORDER BY top.position DESC LIMIT 1) AS runTop
                FROM main.history_actions AS action WHERE ${scoped} AND action.visible = 1 AND action.id = ${id}`);
            return rows[0] ?? null;
        },
        async changes(entry: HistoryEntry): Promise<HistoryRecord[]> {
            if (entry.status !== 'ready' || entry.version === null) throw new Error('Choose a complete synced action.');
            const { readActionChanges } = await import('../history/point-snapshot.js');
            return withTimeout(readActionChanges(entry.previousVersion, entry.version, session.scope), 30_000, 'Could not inspect this action. Try again.');
        },
        async list(options: HistoryListOptions = {}): Promise<HistoryItem[]> {
            const search = options.search?.trim().toLowerCase() ?? '';
            const feature = options.feature ?? '';
            const markers = search || feature ? [] : options.markers ?? [];
            const limit = options.limit ?? 60;
            const where = listFilter(options, search, feature);
            // Read only as many actions from the top as the window needs.
            let fetch = limit;
            for (const anchor of [options.through, options.around]) {
                if (!anchor) continue;
                const ahead = await actionsAhead(where, anchor);
                if (ahead !== null) fetch = Math.max(fetch, ahead + limit + 21);
            }
            const marks = markers.length
                ? sql`VALUES ${sql.join(markers.map(marker => sql`(${marker.key}, ${marker.version})`))}`
                : sql`SELECT NULL, NULL WHERE 0`;
            const { rows } = await execute<((Omit<HistoryEntry, 'copied'> & { kind: 'action'; copied: number })
                | Omit<Extract<HistoryItem, { kind: 'marker' }>, 'row'>) & { row_index: number }>(sql`
                WITH ${blocked},
                top AS (SELECT * FROM (SELECT ${entry} FROM ${actions} WHERE ${where} ORDER BY ${order} LIMIT ${fetch})),
                dated AS (
                    SELECT *, CASE WHEN date(timestamp / 1000, 'unixepoch', 'localtime') IS
                            LAG(date(timestamp / 1000, 'unixepoch', 'localtime')) OVER (ORDER BY pending DESC, position DESC, id DESC)
                            THEN 0 ELSE 1 END AS startsDay
                    FROM top
                ), marks(marker_key, version) AS (${marks}),
                items AS (
                    SELECT 'action' AS kind, id, NULL AS markerKey, label, timestamp, version, previousVersion, eventCount,
                        feature, actor, status, reason, startsDay,
                        CASE WHEN version IS NOT NULL AND version <= ${options.sourceVersion ?? -1} THEN 1 ELSE 0 END AS copied,
                        pending, position * 2 AS sort
                    FROM dated
                    UNION ALL
                    -- A log that shares version v sits between action v and the one after it.
                    SELECT 'marker', 'marker:' || marker_key, marker_key, NULL, NULL, version, NULL, NULL,
                        NULL, NULL, NULL, NULL, 0, 0, 0, version * 2 + 1 FROM marks
                ), numbered AS (
                    SELECT *, ROW_NUMBER() OVER (ORDER BY pending DESC, sort DESC, id DESC) AS row_index FROM items
                ), bounds AS (
                    SELECT MAX(0, COALESCE((SELECT row_index FROM numbered WHERE id = ${options.around ?? ''}), 1) - 21) AS start
                )
                SELECT numbered.*, (SELECT COUNT(*) FROM main.history_actions AS action WHERE ${where}) + ${markers.length} AS total
                FROM numbered, bounds
                WHERE row_index > bounds.start
                  AND row_index <= MAX(bounds.start + ${limit}, COALESCE((SELECT row_index FROM numbered WHERE id = ${options.through ?? ''}), 0) + 20)
                ORDER BY row_index`);
            return rows.map(({ row_index: row, ...item }) => item.kind === 'action'
                ? { ...item, row, copied: Boolean(item.copied) }
                : { ...item, row });
        },
        /** The newest synced action, where Copy this log starts. */
        async latest(): Promise<HistoryEntry | null> {
            const { rows } = await execute<HistoryEntry>(sql`WITH ${blocked}
                SELECT ${entry}, 0 AS total, 0 AS startsDay FROM ${actions}
                WHERE ${scoped} AND action.visible = 1 AND action.complete = 1 AND NOT ${attention}
                ORDER BY action.version DESC LIMIT 1`);
            return rows[0] ?? null;
        },
        /** When the newest action happened, so the log map can end there. */
        async newest(): Promise<number | null> {
            const { rows } = await execute<{ newest: number | null }>(sql`SELECT action.timestamp AS newest
                FROM main.history_actions AS action WHERE ${scoped} AND action.visible = 1
                ORDER BY action.timestamp DESC LIMIT 1`);
            return rows[0]?.newest ?? null;
        },
        /**
         * Actions within a time span, newest first, for the log map's points. A span with more than ${MAP_POINTS}
         * draws one point per slice of time instead (its newest action, with how many it stands for), kept apart on
         * either side of `splitAt` so copied and own actions stay on their lines.
         */
        async points(since: number, until: number, splitAt: number | null = null): Promise<HistoryPoint[]> {
            const span = sql`${scoped} AND action.visible = 1 AND action.timestamp >= ${since} AND action.timestamp <= ${until}`;
            const { rows: [counted] } = await execute<{ count: number }>(sql`SELECT COUNT(*) AS count
                FROM main.history_actions AS action WHERE ${span}`);
            if (Number(counted?.count ?? 0) <= MAP_POINTS) {
                const { rows } = await execute<HistoryPoint>(sql`SELECT action.id, action.label, action.timestamp, action.version
                    FROM main.history_actions AS action WHERE ${span}
                    ORDER BY action.timestamp DESC, action.id DESC`);
                return rows;
            }
            const width = Math.max(1, (until - since) / MAP_SLICES);
            // With one MAX() aggregate SQLite takes the other columns from the row holding the maximum.
            const { rows } = await execute<HistoryPoint>(sql`SELECT action.id, action.label, MAX(action.timestamp) AS timestamp,
                    action.version, COUNT(*) AS count
                FROM main.history_actions AS action WHERE ${span}
                GROUP BY CAST((action.timestamp - ${since}) / ${width} AS INTEGER),
                    COALESCE(action.version, ${Number.MAX_SAFE_INTEGER}) <= ${splitAt ?? -1}
                ORDER BY timestamp DESC`);
            return rows.map((row) => ({ ...row, count: Number(row.count) }));
        },
        async get(selection: { id?: string; version?: number }): Promise<HistoryEntry | null> {
            const { rows } = await execute<HistoryEntry>(sql`WITH ${blocked}
                SELECT ${entry}, 0 AS total, 0 AS startsDay FROM ${actions}
                WHERE ${scoped} AND action.visible = 1
                  AND ${selection.id ? sql`action.id = ${selection.id}` : sql`action.version = ${selection.version ?? -1}`}
                LIMIT 1`);
            return rows[0] ?? null;
        },
        async review(targetVersion: number): Promise<ForkReview> {
            const { rows } = await execute<ForkReview>(sql`
                WITH feature_labels(feature, label) AS (VALUES ${historyFeatureLabels}),
                feature_keys(feature) AS (VALUES ${featureKeys}),
                later AS (SELECT action.features FROM main.history_actions AS action
                    WHERE ${scoped} AND action.accepted = 1 AND action.version > ${targetVersion})
                SELECT (SELECT COUNT(*) FROM main.history_actions AS action
                        WHERE ${scoped} AND action.accepted = 1 AND action.first_version <= ${targetVersion}) AS keptActions,
                    (SELECT COUNT(*) FROM later) AS laterActions,
                    COALESCE((SELECT group_concat(label, ', ') FROM (
                        SELECT DISTINCT COALESCE(feature_labels.label, 'Other changes') AS label
                        FROM feature_keys LEFT JOIN feature_labels ON feature_labels.feature = feature_keys.feature
                        WHERE EXISTS (SELECT 1 FROM later WHERE instr(later.features, ',' || feature_keys.feature || ',') > 0)
                        ORDER BY label
                    )), '') AS features,
                    COALESCE((SELECT MAX(log_version) FROM main.raw_events
                        WHERE tenant_id = ${tenantId} AND log_id = ${logId}), 0) AS localHead`);
            return rows[0];
        },
        async savedValues(id: string): Promise<HistoryRecord[]> {
            const { rows } = await execute<{ key: string; label: string; fields: string }>(sql`
                WITH metadata(prefix, feature, entity_label, plural_label) AS (VALUES ${historyMetadata}),
                target AS (SELECT group_id FROM main.history_actions AS action WHERE ${scoped} AND action.id = ${id})
                SELECT raw_events.id AS key,
                    COALESCE(${historyEventLabel}, metadata.entity_label, raw_events.type) AS label,
                    (SELECT json_group_array(json_object('key', key, 'label', replace(key, '_', ' '), 'after', value))
                        FROM (SELECT key, value FROM json_each(raw_events.payload)
                            WHERE key NOT IN ('id', 'tenant_id', 'log_id', 'created_at', 'updated_at') ORDER BY key)) AS fields
                FROM main.raw_events AS raw_events, target
                LEFT JOIN metadata ON substr(raw_events.type, 1, length(metadata.prefix)) = metadata.prefix
                WHERE raw_events.tenant_id = ${tenantId} AND raw_events.log_id = ${logId}
                  AND (raw_events.action_id = target.group_id OR (raw_events.action_id IS NULL AND raw_events.id = target.group_id))
                ORDER BY raw_events.action_index, raw_events.local_sequence, raw_events.id`);
            return rows.map(row => ({ ...row, kind: 'saved', fields: JSON.parse(row.fields) }));
        },
    };
}
