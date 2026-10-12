import { sql } from 'kysely';
import type { ReadModelSession } from './read-session.js';
import { ENTITY_DEFINITIONS, getEventPrefix } from '@hearthlog/contracts/event/entity-definitions';
import { FEATURES } from '@hearthlog/contracts/features/registry';
import { visibleEventCondition } from '../event/queries.js';
import { completeActionBoundary } from '../history/action-boundary.js';
import type { ForkReview, HistoryEntry, HistoryItem, HistoryListOptions, HistoryPoint, HistoryRecord } from '../history/contracts.js';
import { withTimeout } from '../utils/async.js';

// Registry metadata, never user records. All activity selection and aggregation stays in SQL.
const metadata = sql.join(ENTITY_DEFINITIONS.map(entity => sql`(
    ${getEventPrefix(entity)}, ${entity.feature}, ${entity.displayName ?? entity.name.replace(/_/g, ' ')}, ${entity.table.replace(/_/g, ' ')}
)`));
const featureLabels = sql.join(FEATURES.map(feature => sql`(${feature.id}, ${feature.page?.label ?? feature.id})`));
// Records without a name read as their main value, such as "Weight 81.2 kg";
// entity definitions declare it (`summary`).
const summarized = ENTITY_DEFINITIONS.filter((entity) => entity.summary);
const summaries = summarized.length
    ? sql`VALUES ${sql.join(summarized.map((entity) => sql`(${getEventPrefix(entity)}, ${entity.summary!.noun}, ${entity.summary!.key}, ${entity.summary!.unit})`))}`
    : sql`SELECT NULL, NULL, NULL, NULL WHERE 0`;
const order = sql`(version IS NULL) DESC, COALESCE(version, local_sequence) DESC, id DESC`;

export function createHistoryRepository(session: ReadModelSession) {
    const base = sql`
        WITH raw_events AS (SELECT * FROM ${session.table('raw_events')}),
        metadata(prefix, feature, entity_label, plural_label) AS (VALUES ${metadata}),
        feature_labels(feature, label) AS (VALUES ${featureLabels}),
        summaries(prefix, noun, key, unit) AS (${summaries}),
        enriched AS (
            SELECT raw_events.*, COALESCE(action_id, id) AS group_id,
                metadata.feature, metadata.entity_label, metadata.plural_label,
                CASE WHEN ${visibleEventCondition()} THEN 1 ELSE 0 END AS visible,
                CASE WHEN log_version IS NOT NULL AND projection_state IN ('effective', 'restored_out')
                    AND ${completeActionBoundary} THEN 1 ELSE 0 END AS complete,
                (SELECT CAST(value AS TEXT) FROM raw_events AS prior, json_each(prior.payload)
                    WHERE COALESCE(prior.entity_id, json_extract(prior.payload, '$.id'), prior.id)
                        = COALESCE(raw_events.entity_id, json_extract(raw_events.payload, '$.id'), raw_events.id)
                      AND key IN ('title', 'name', 'invoiceNumber', 'number', 'description', 'label', 'filename', 'fileName')
                      AND json_each.type = 'text' AND trim(CAST(value AS TEXT)) != ''
                      AND (prior.id = raw_events.id OR (prior.projection_state IN ('effective', 'restored_out')
                        AND prior.is_tombstoned = 0 AND (
                            (raw_events.log_version IS NOT NULL AND prior.log_version <= raw_events.log_version)
                            OR (raw_events.log_version IS NULL AND prior.local_sequence <= raw_events.local_sequence))))
                    ORDER BY (prior.id = raw_events.id) DESC, prior.log_version DESC, prior.local_sequence DESC,
                        CASE key WHEN 'title' THEN 0 WHEN 'name' THEN 1 WHEN 'invoiceNumber' THEN 2 WHEN 'number' THEN 3
                            WHEN 'description' THEN 4 ELSE 5 END
                    LIMIT 1) AS record_label,
                (SELECT noun || ' ' || printf('%g', json_extract(raw_events.payload, '$.' || key)) || unit FROM summaries
                    WHERE substr(raw_events.type, 1, length(prefix)) = prefix
                      AND json_type(raw_events.payload, '$.' || key) IN ('integer', 'real')) AS summary_label,
                (SELECT lower(noun) FROM summaries WHERE substr(raw_events.type, 1, length(prefix)) = prefix) AS summary_noun,
                (SELECT operation.last_error_message FROM outbox_operation_items AS item
                    JOIN ${session.table('outbox_operations')} AS operation ON operation.id = item.operation_id
                    WHERE item.event_id = raw_events.id AND operation.status = 'needs_attention'
                    ORDER BY operation.updated_at DESC LIMIT 1) AS sync_error
            FROM raw_events LEFT JOIN metadata ON substr(raw_events.type, 1, length(prefix)) = prefix
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY group_id
                    ORDER BY log_version DESC, action_index DESC, local_sequence DESC, id DESC) AS rank,
                COUNT(*) OVER (PARTITION BY group_id) AS member_count,
                MAX(visible) OVER (PARTITION BY group_id) AS has_visible,
                MAX(CASE WHEN sync_state IN ('conflicted', 'rejected') OR projection_state = 'excluded'
                    OR sync_error IS NOT NULL THEN 1 ELSE 0 END) OVER (PARTITION BY group_id) AS attention,
                MAX(COALESCE(rejection_detail, rejection_code, sync_error)) OVER (PARTITION BY group_id) AS issue,
                MIN(log_version) OVER (PARTITION BY group_id) AS first_version
            FROM enriched
        ), actions AS (
            SELECT id, group_id, type, timestamp, log_version AS version, local_sequence, feature, actor,
                COALESCE(action_size, member_count) AS eventCount,
                COALESCE(first_version - 1, 0) AS previousVersion,
                CASE WHEN attention = 1 THEN 'attention' WHEN complete = 1 THEN 'ready' ELSE 'waiting' END AS status,
                CASE WHEN attention = 1 THEN COALESCE(issue, 'Open sync issues to review this action.')
                    WHEN complete = 1 THEN NULL
                    WHEN log_version IS NULL THEN 'Saved on this device. Waiting to sync.'
                    ELSE 'This action is still arriving. Wait for sync to finish.' END AS reason,
                CASE WHEN COALESCE(action_size, member_count) > 1 THEN
                    CASE WHEN record_label IS NOT NULL AND (
                        SELECT COUNT(DISTINCT COALESCE(entity_id, json_extract(payload, '$.id'), id))
                        FROM enriched AS member WHERE member.group_id = ranked.group_id
                    ) = 1 THEN 'Edited ' || record_label
                    WHEN (SELECT COUNT(DISTINCT type) FROM enriched AS member WHERE member.group_id = ranked.group_id) = 1
                        THEN CASE WHEN type LIKE '%_ADDED' THEN 'Added ' WHEN type LIKE '%_REMOVED' THEN 'Removed ' ELSE 'Edited ' END
                            || member_count || ' ' || COALESCE(plural_label, 'records')
                    ELSE COALESCE((SELECT label FROM feature_labels WHERE feature_labels.feature = ranked.feature), 'Log') || ' action' END
                WHEN type = 'WORKSPACE_RESTORED' THEN 'Restored log'
                WHEN type = 'EVENTS_EXCISED' THEN 'Removed events'
                WHEN type = 'EVENT_TOMBSTONED' THEN 'Undid a change'
                ELSE CASE WHEN type LIKE '%_ADDED' THEN 'Added '
                    WHEN type LIKE '%_UPDATED' THEN 'Edited '
                    WHEN type LIKE '%_REMOVED' OR type LIKE '%_DELETED' THEN 'Removed '
                    ELSE 'Changed ' END || COALESCE(record_label, summary_label, summary_noun, entity_label, lower(replace(type, '_', ' '))) END AS label
            FROM ranked WHERE rank = 1 AND has_visible = 1
        )`;

    function execute<T>(query: import('kysely').RawBuilder<T>) {
        return withTimeout(session.execute(query), 15_000, 'History could not be loaded. Try again.');
    }

    return {
        async changes(entry: HistoryEntry): Promise<HistoryRecord[]> {
            if (entry.status !== 'ready' || entry.version === null) throw new Error('Choose a complete synced action.');
            const { readActionChanges } = await import('../history/point-snapshot.js');
            return withTimeout(readActionChanges(entry.previousVersion, entry.version, session.scope), 30_000, 'Could not inspect this action. Try again.');
        },
        async list(options: HistoryListOptions = {}): Promise<HistoryItem[]> {
            const search = options.search?.trim() ?? '';
            const feature = options.feature ?? '';
            const markers = search || feature ? [] : options.markers ?? [];
            const marks = markers.length
                ? sql`VALUES ${sql.join(markers.map(marker => sql`(${marker.key}, ${marker.version})`))}`
                : sql`SELECT NULL, NULL WHERE 0`;
            const { rows } = await execute<(Omit<HistoryEntry, 'copied'> & { kind: 'action'; copied: number })
                | Extract<HistoryItem, { kind: 'marker' }>>(sql`${base}, filtered AS (
                SELECT *, CASE WHEN date(timestamp / 1000, 'unixepoch', 'localtime') IS
                        LAG(date(timestamp / 1000, 'unixepoch', 'localtime')) OVER (ORDER BY ${order})
                        THEN 0 ELSE 1 END AS startsDay
                FROM actions WHERE (${feature} = '' OR EXISTS (
                    SELECT 1 FROM enriched AS member WHERE member.group_id = actions.group_id AND member.feature = ${feature}
                )) AND (${search} = '' OR instr(lower(label), lower(${search})) > 0
                    OR EXISTS (SELECT 1 FROM enriched AS member WHERE member.group_id = actions.group_id
                        AND instr(lower(member.payload || ' ' || member.type), lower(${search})) > 0))
            ), marks(marker_key, version) AS (${marks}),
            items AS (
                SELECT 'action' AS kind, id, NULL AS markerKey, label, timestamp, version, previousVersion, eventCount,
                    feature, actor, status, reason, startsDay,
                    CASE WHEN version IS NOT NULL AND version <= ${options.sourceVersion ?? -1} THEN 1 ELSE 0 END AS copied,
                    CASE WHEN version IS NULL THEN 1 ELSE 0 END AS pending,
                    COALESCE(version, local_sequence) * 2 AS position
                FROM filtered
                UNION ALL
                -- A log that shares version v sits between action v and the one after it.
                SELECT 'marker', 'marker:' || marker_key, marker_key, NULL, NULL, version, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0, 0, 0, version * 2 + 1 FROM marks
            ), numbered AS (
                SELECT *, ROW_NUMBER() OVER (ORDER BY pending DESC, position DESC, id DESC) AS row_number,
                    COUNT(*) OVER () AS total
                FROM items
            ) SELECT * FROM numbered
            WHERE row_number <= MAX(${options.limit ?? 60},
                COALESCE((SELECT row_number FROM numbered WHERE id = ${options.through ?? ''}), 0) + 20)
            ORDER BY row_number`);
            return rows.map(row => row.kind === 'action' ? { ...row, copied: Boolean(row.copied) } : row);
        },
        /** The newest synced action, where Copy this log starts. */
        async latest(): Promise<HistoryEntry | null> {
            const { rows } = await execute<HistoryEntry>(sql`${base} SELECT *, 0 AS total, 0 AS startsDay FROM actions
                WHERE status = 'ready' ORDER BY version DESC LIMIT 1`);
            return rows[0] ?? null;
        },
        /** When the newest action happened, so the log map can end there. */
        async newest(): Promise<number | null> {
            const { rows } = await execute<{ newest: number | null }>(sql`${base} SELECT MAX(timestamp) AS newest FROM actions`);
            return rows[0]?.newest ?? null;
        },
        /** Actions within a time span, newest first, for the log map's points. */
        async points(since: number, until: number, limit = 3000): Promise<HistoryPoint[]> {
            const { rows } = await execute<HistoryPoint>(sql`${base}
                SELECT id, label, timestamp, version FROM actions WHERE timestamp >= ${since} AND timestamp <= ${until}
                ORDER BY timestamp DESC, id DESC LIMIT ${limit}`);
            return rows;
        },
        async get(selection: { id?: string; version?: number }): Promise<HistoryEntry | null> {
            const { rows } = await execute<HistoryEntry>(sql`${base} SELECT *, 0 AS total, 0 AS startsDay FROM actions
                WHERE ${selection.id ? sql`id = ${selection.id}` : sql`version = ${selection.version ?? -1}`} LIMIT 1`);
            return rows[0] ?? null;
        },
        async review(targetVersion: number): Promise<ForkReview> {
            const { rows } = await execute<ForkReview>(sql`${base}, later AS (
                SELECT DISTINCT group_id FROM enriched WHERE log_version > ${targetVersion}
                    AND projection_state IN ('effective', 'restored_out')
            ), kept AS (
                SELECT DISTINCT group_id FROM enriched WHERE log_version <= ${targetVersion}
                    AND projection_state IN ('effective', 'restored_out')
            ) SELECT (SELECT COUNT(*) FROM kept) AS keptActions, (SELECT COUNT(*) FROM later) AS laterActions,
                COALESCE((SELECT group_concat(label, ', ') FROM (
                    SELECT DISTINCT COALESCE(feature_labels.label, 'Other changes') AS label
                    FROM enriched LEFT JOIN feature_labels ON feature_labels.feature = enriched.feature
                    WHERE log_version > ${targetVersion} AND projection_state IN ('effective', 'restored_out') ORDER BY label
                )), '') AS features,
                COALESCE((SELECT MAX(log_version) FROM raw_events), 0) AS localHead`);
            return rows[0];
        },
        async savedValues(id: string): Promise<HistoryRecord[]> {
            const { rows } = await execute<{ key: string; label: string; fields: string }>(sql`${base}
                SELECT member.id AS key, COALESCE(member.record_label, member.entity_label, member.type) AS label,
                    (SELECT json_group_array(json_object('key', key, 'label', replace(key, '_', ' '), 'after', value))
                        FROM (SELECT key, value FROM json_each(member.payload)
                            WHERE key NOT IN ('id', 'tenant_id', 'log_id', 'created_at', 'updated_at') ORDER BY key)) AS fields
                FROM enriched AS member WHERE member.group_id = (SELECT group_id FROM actions WHERE id = ${id})
                ORDER BY member.action_index, member.local_sequence, member.id`);
            return rows.map(row => ({ ...row, kind: 'saved', fields: JSON.parse(row.fields) }));
        },
    };
}
