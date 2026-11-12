/**
 * Log history's action index (`history_actions`, see `db/history-index-schema.ts`).
 *
 * The history list used to group and name every event of the log on each read, which stopped working past tens of
 * thousands of events. The same derivation now runs once per action when its events change, and reads page through
 * the index. Maintenance is derived, not incremental: `indexActions` recomputes whole actions from `raw_events`, so
 * calling it twice is harmless, and anything that rewrites history broadly marks the log's index stale instead
 * (`markHistoryIndexStale`); the next read rebuilds it in chunks (`ensureHistoryIndex`).
 */
import { sql, type QueryResult, type RawBuilder } from 'kysely';
import { ENTITY_DEFINITIONS, getEventPrefix } from '@hearthlog/contracts/event/entity-definitions';
import { FEATURES } from '@hearthlog/contracts/features/registry';
import { visibleEventCondition } from '../event/queries.js';
import { completeActionBoundary } from './action-boundary.js';
import { HISTORY_INDEX_FORMAT } from '../db/history-index-schema.js';

export type HistoryScope = { tenantId: string; logId: string };
/** Runs one statement: a transaction's or a read session's `execute`. */
export type SqlRunner = <T>(query: RawBuilder<T>) => Promise<QueryResult<T>>;

/** Event types that change which events replay, or a record's earlier events; a log holding them reindexes whole. */
export const HISTORY_REWRITING_TYPES: readonly string[] = ['EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED'];

// Registry metadata, never user records.
export const historyMetadata = sql.join(ENTITY_DEFINITIONS.map(entity => sql`(
    ${getEventPrefix(entity)}, ${entity.feature}, ${entity.displayName ?? entity.name.replace(/_/g, ' ')}, ${entity.table.replace(/_/g, ' ')}
)`));
export const historyFeatureLabels = sql.join(FEATURES.map(feature => sql`(${feature.id}, ${feature.page?.label ?? feature.id})`));
const summarized = ENTITY_DEFINITIONS.filter((entity) => entity.summary);
const summaries = summarized.length
    ? sql`VALUES ${sql.join(summarized.map((entity) => sql`(${getEventPrefix(entity)}, ${entity.summary!.noun}, ${entity.summary!.key}, ${entity.summary!.unit})`))}`
    : sql`SELECT NULL, NULL, NULL, NULL WHERE 0`;

/**
 * The newest name a record had at this event, read from its earlier events (`raw_events` is the outer event).
 * Events carry their record as `entity_id`, so the lookup is one index range per event.
 */
export function historyRecordLabel(sameRecord: RawBuilder<unknown>): RawBuilder<unknown> {
    return sql`(SELECT CAST(value AS TEXT) FROM main.raw_events AS prior, json_each(prior.payload)
                    WHERE prior.tenant_id = raw_events.tenant_id AND prior.log_id = raw_events.log_id AND ${sameRecord}
                      AND key IN ('title', 'name', 'invoiceNumber', 'number', 'description', 'label', 'filename', 'fileName')
                      AND json_each.type = 'text' AND trim(CAST(value AS TEXT)) != ''
                      AND (prior.id = raw_events.id OR (prior.projection_state IN ('effective', 'restored_out')
                        AND prior.is_tombstoned = 0 AND (
                            (raw_events.log_version IS NOT NULL AND prior.log_version <= raw_events.log_version)
                            OR (raw_events.log_version IS NULL AND prior.local_sequence <= raw_events.local_sequence))))
                    ORDER BY (prior.id = raw_events.id) DESC, prior.log_version DESC, prior.local_sequence DESC,
                        CASE key WHEN 'title' THEN 0 WHEN 'name' THEN 1 WHEN 'invoiceNumber' THEN 2 WHEN 'number' THEN 3
                            WHEN 'description' THEN 4 ELSE 5 END
                    LIMIT 1)`;
}

/** A record's label for one event: by entity id, or by payload id for the rare event without one. */
export const historyEventLabel = sql`CASE WHEN raw_events.entity_id IS NOT NULL
    THEN ${historyRecordLabel(sql`prior.entity_id = raw_events.entity_id`)}
    ELSE ${historyRecordLabel(sql`COALESCE(prior.entity_id, json_extract(prior.payload, '$.id'), prior.id)
        = COALESCE(raw_events.entity_id, json_extract(raw_events.payload, '$.id'), raw_events.id)`)} END`;

/**
 * Events of the given actions: an accepted action by its id, a local event (no action yet) by its own id. CROSS JOIN
 * keeps the keys as the outer loop, so both halves are index lookups; an OR across the two lets SQLite scan the log.
 */
function membersOf(scope: HistoryScope, keys: string): RawBuilder<unknown> {
    return sql`SELECT event.*, event.action_id AS group_id FROM json_each(${keys}) AS wanted
            CROSS JOIN main.raw_events AS event
            WHERE event.tenant_id = ${scope.tenantId} AND event.log_id = ${scope.logId} AND event.action_id = wanted.value
        UNION ALL
        SELECT event.*, event.id AS group_id FROM json_each(${keys}) AS wanted
            CROSS JOIN main.raw_events AS event
            WHERE event.tenant_id = ${scope.tenantId} AND event.log_id = ${scope.logId} AND event.id = wanted.value
              AND event.action_id IS NULL`;
}

/** Recompute the given actions' rows. Keys that no longer name an action simply produce no row. */
async function materialize(run: SqlRunner, scope: HistoryScope, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const json = JSON.stringify(keys);
    await run(sql`
        WITH metadata(prefix, feature, entity_label, plural_label) AS (VALUES ${historyMetadata}),
        feature_labels(feature, label) AS (VALUES ${historyFeatureLabels}),
        summaries(prefix, noun, key, unit) AS (${summaries}),
        members AS (${membersOf(scope, json)}),
        enriched AS (
            SELECT raw_events.*, metadata.feature, metadata.entity_label, metadata.plural_label,
                CASE WHEN ${visibleEventCondition()} THEN 1 ELSE 0 END AS visible,
                CASE WHEN raw_events.log_version IS NOT NULL AND raw_events.projection_state IN ('effective', 'restored_out')
                    AND ${completeActionBoundary} THEN 1 ELSE 0 END AS complete,
                ${historyEventLabel} AS record_label,
                (SELECT noun || ' ' || printf('%g', json_extract(raw_events.payload, '$.' || key)) || unit FROM summaries
                    WHERE substr(raw_events.type, 1, length(prefix)) = prefix
                      AND json_type(raw_events.payload, '$.' || key) IN ('integer', 'real')) AS summary_label,
                (SELECT lower(noun) FROM summaries WHERE substr(raw_events.type, 1, length(prefix)) = prefix) AS summary_noun
            FROM members AS raw_events LEFT JOIN metadata ON substr(raw_events.type, 1, length(prefix)) = prefix
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY group_id
                    ORDER BY log_version DESC, action_index DESC, local_sequence DESC, id DESC) AS rank,
                COUNT(*) OVER grouped AS member_count,
                MAX(visible) OVER grouped AS has_visible,
                MAX(CASE WHEN sync_state IN ('conflicted', 'rejected') OR projection_state = 'excluded' THEN 1 ELSE 0 END) OVER grouped AS settled_attention,
                MAX(COALESCE(rejection_detail, rejection_code)) OVER grouped AS issue,
                MIN(log_version) OVER grouped AS first_version,
                MAX(CASE WHEN log_version IS NOT NULL AND projection_state IN ('effective', 'restored_out') THEN 1 ELSE 0 END) OVER grouped AS accepted
            FROM enriched
            WINDOW grouped AS (PARTITION BY group_id)
        ), group_facts AS (
            SELECT group_id,
                COUNT(DISTINCT COALESCE(entity_id, json_extract(payload, '$.id'), id)) AS record_count,
                COUNT(DISTINCT type) AS type_count,
                ',' || group_concat(DISTINCT COALESCE(feature, '~')) || ',' AS features,
                group_concat(DISTINCT lower(type) || ' ' || lower(replace(type, '_', ' '))) AS types
            FROM enriched GROUP BY group_id
        ), labelled AS (
            SELECT ranked.*, group_facts.features, group_facts.types,
                CASE WHEN COALESCE(action_size, member_count) > 1 THEN
                    CASE WHEN record_label IS NOT NULL AND group_facts.record_count = 1 THEN 'Edited ' || record_label
                    WHEN group_facts.type_count = 1
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
            FROM ranked JOIN group_facts ON group_facts.group_id = ranked.group_id WHERE rank = 1
        )
        INSERT OR REPLACE INTO history_actions (tenant_id, log_id, group_id, id, label, type, timestamp, version,
            local_sequence, first_version, event_count, feature, features, actor, visible, complete, settled_attention,
            issue, accepted, search_text, pending, position, run_start)
        SELECT tenant_id, log_id, group_id, id, label, type, timestamp, log_version, local_sequence, first_version,
            COALESCE(action_size, member_count), feature, features, actor, has_visible, complete, settled_attention,
            issue, accepted, lower(label) || ' ' || COALESCE(types, ''),
            CASE WHEN log_version IS NULL THEN 1 ELSE 0 END, COALESCE(log_version, local_sequence),
            COALESCE(log_version, local_sequence)
        FROM labelled
    `);
}

/** Two actions this close in time, of the same kind, section and author, belong to one burst. */
const BURST_GAP_MS = 2 * 60 * 1000;

/**
 * Group consecutive accepted actions into bursts (an import, a bulk edit, a run of saves to one record): each action's
 * `run_start` becomes the position of the oldest action of its burst, so the list pages bursts as one row from the
 * index. Actions on their own, waiting ones, and ones set aside keep their own position. Only actions from `from` up
 * are reconsidered, continuing the burst of the action just below; new actions arrive at the top, so this is cheap.
 */
async function refreshRuns(run: SqlRunner, scope: HistoryScope, from: number): Promise<void> {
    const rewriting = sql.join(HISTORY_REWRITING_TYPES.map((type) => sql`${type}`));
    await run(sql`
        WITH below AS (
            SELECT position, run_start, type, feature, actor, timestamp, 1 AS anchored FROM history_actions
            WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId} AND visible = 1 AND pending = 0 AND position < ${from}
            ORDER BY position DESC LIMIT 1
        ), chain AS (
            SELECT * FROM below
            UNION ALL
            SELECT position, run_start, type, feature, actor, timestamp, 0 FROM history_actions
            WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId} AND visible = 1 AND pending = 0 AND position >= ${from}
        ), marked AS (
            SELECT position, anchored, CASE
                WHEN anchored = 1 THEN COALESCE(run_start, position)
                WHEN type NOT IN (${rewriting}) AND LAG(type) OVER ordered = type AND LAG(feature) OVER ordered IS feature
                    AND LAG(actor) OVER ordered IS actor AND abs(timestamp - LAG(timestamp) OVER ordered) <= ${BURST_GAP_MS}
                    THEN NULL
                ELSE position END AS starts
            FROM chain WINDOW ordered AS (ORDER BY position)
        ), runs AS (
            SELECT position, MAX(starts) OVER (ORDER BY position ROWS UNBOUNDED PRECEDING) AS run_start FROM marked
        )
        UPDATE history_actions SET run_start = runs.run_start FROM runs
        WHERE history_actions.tenant_id = ${scope.tenantId} AND history_actions.log_id = ${scope.logId}
          AND history_actions.pending = 0 AND history_actions.visible = 1 AND history_actions.position = runs.position
          AND history_actions.position >= ${from} AND history_actions.run_start IS NOT runs.run_start
    `);
}

/** Larger changes than this only drop their actions' rows and leave them to the next build (see `indexActions`). */
const DEFER_ABOVE_EVENTS = 200;

/**
 * Recompute the actions these events belong to, in the caller's transaction. An event that waited as its own action
 * and was accepted into a larger one leaves its old row behind, so the events' own ids are cleared too.
 *
 * While a log's index is not built (a new device catching up), or for a large page of events, the affected rows are
 * only dropped and the log is marked incomplete: the next history read builds what is missing in one pass, which is
 * far cheaper than indexing page by page.
 */
export async function indexActions(run: SqlRunner, scope: HistoryScope, eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const ids = JSON.stringify([...new Set(eventIds)]);
    const { rows } = await run(sql<{ key: string }>`
        SELECT DISTINCT COALESCE(action_id, id) AS key FROM main.raw_events
        WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId} AND id IN (SELECT value FROM json_each(${ids}))`);
    const keys = [...new Set([...eventIds, ...rows.map((row) => row.key)])];
    await run(sql`DELETE FROM history_actions WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId}
        AND group_id IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`);
    const { rows: [state] } = await run(sql<{ built: number; format: number }>`SELECT built, format FROM history_index_state
        WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId}`);
    if (state?.built === 1 && state.format === HISTORY_INDEX_FORMAT && eventIds.length <= DEFER_ABOVE_EVENTS) {
        await materialize(run, scope, keys);
        const { rows: [lowest] } = await run(sql<{ position: number | null }>`SELECT MIN(position) AS position FROM history_actions
            WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId} AND pending = 0
              AND group_id IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`);
        if (lowest?.position != null) await refreshRuns(run, scope, lowest.position);
    } else if (state?.built === 1) {
        await run(sql`UPDATE history_index_state SET built = 0 WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId}`);
    }
}

/** Recompute every action of a local batch (its events changed state together). */
export async function indexBatchActions(run: SqlRunner, scope: HistoryScope, batchId: string): Promise<void> {
    const { rows } = await run(sql<{ id: string }>`SELECT id FROM main.raw_events
        WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId} AND local_batch_id = ${batchId}`);
    await indexActions(run, scope, rows.map((row) => row.id));
}

/** Drop a log's index; the next history read rebuilds it from `raw_events`. */
export async function markHistoryIndexStale(run: SqlRunner, scope: HistoryScope): Promise<void> {
    await run(sql`DELETE FROM history_actions WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId}`);
    await run(sql`DELETE FROM history_index_state WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId}`);
}

/** Index the given events, or the whole log when they hold anything that rewrites earlier history. */
export async function indexIngestedActions(
    run: SqlRunner,
    scope: HistoryScope,
    events: ReadonlyArray<{ id: string; type: string }>,
): Promise<void> {
    if (events.some((event) => HISTORY_REWRITING_TYPES.includes(event.type))) {
        await markHistoryIndexStale(run, scope);
        return;
    }
    await indexActions(run, scope, events.map((event) => event.id));
}

/** Small enough that one chunk never holds the database worker for long. */
const BUILD_CHUNK = 250;
const building = new Map<string, Promise<void>>();

/**
 * Make sure the log's index holds every action, building what is missing in chunks of actions so other reads and
 * writes interleave. Actions indexed meanwhile by ordinary maintenance are kept; an interrupted build resumes.
 */
export function ensureHistoryIndex(run: SqlRunner, scope: HistoryScope): Promise<void> {
    const key = `${scope.tenantId}\u0000${scope.logId}`;
    const existing = building.get(key);
    if (existing) return existing;
    const job = (async () => {
        const { rows: [state] } = await run(sql<{ format: number; built: number }>`SELECT format, built FROM history_index_state
            WHERE tenant_id = ${scope.tenantId} AND log_id = ${scope.logId}`);
        if (state?.built === 1 && state.format === HISTORY_INDEX_FORMAT) return;
        if (state && state.format !== HISTORY_INDEX_FORMAT) await markHistoryIndexStale(run, scope);
        // Repeat until nothing is missing: the log can be marked stale (here or in another tab) mid-build.
        for (let pass = 0; pass < 5; pass++) {
            // Newest first, so the top of the list is ready soonest.
            const { rows } = await run(sql<{ key: string }>`
                SELECT COALESCE(event.action_id, event.id) AS key FROM main.raw_events AS event
                WHERE event.tenant_id = ${scope.tenantId} AND event.log_id = ${scope.logId}
                  AND NOT EXISTS (SELECT 1 FROM history_actions AS action WHERE action.tenant_id = event.tenant_id
                    AND action.log_id = event.log_id AND action.group_id = COALESCE(event.action_id, event.id))
                GROUP BY 1 ORDER BY MAX(event.log_version IS NULL) DESC, MAX(COALESCE(event.log_version, event.local_sequence)) DESC`);
            if (rows.length === 0) break;
            for (let offset = 0; offset < rows.length; offset += BUILD_CHUNK) {
                await materialize(run, scope, rows.slice(offset, offset + BUILD_CHUNK).map((row) => row.key));
                // Let queued reads and saves run between chunks.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
        await refreshRuns(run, scope, 0);
        await run(sql`INSERT OR REPLACE INTO history_index_state (tenant_id, log_id, format, built)
            VALUES (${scope.tenantId}, ${scope.logId}, ${HISTORY_INDEX_FORMAT}, 1)`);
    })().finally(() => building.delete(key));
    building.set(key, job);
    return job;
}
