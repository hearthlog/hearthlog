/**
 * Log history's action index: one row per action (an accepted action, or a local event still waiting), derived from
 * `raw_events` the same way the history list always named and grouped actions. It is a projection: it can be dropped
 * and refilled at any time (`history/action-index.ts`), and nothing reads it as a source of truth.
 *
 * Raise the format when the derivation changes; every log then rebuilds its index on the next history read.
 */
export const HISTORY_INDEX_FORMAT = 2;

/** Columns added after the table first shipped, added in place to an existing table before the indexes are created. */
export const HISTORY_INDEX_ADDED_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [['run_start', 'INTEGER']];

export const HISTORY_INDEX_DDL: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS history_actions (
        tenant_id TEXT NOT NULL,
        log_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        version INTEGER,
        local_sequence INTEGER NOT NULL,
        first_version INTEGER,
        event_count INTEGER NOT NULL,
        feature TEXT,
        features TEXT NOT NULL,
        actor TEXT,
        visible INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        settled_attention INTEGER NOT NULL,
        issue TEXT,
        accepted INTEGER NOT NULL,
        search_text TEXT NOT NULL,
        pending INTEGER NOT NULL,
        position INTEGER NOT NULL,
        run_start INTEGER,
        PRIMARY KEY (tenant_id, log_id, group_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS history_actions_id ON history_actions (tenant_id, log_id, id)`,
    `CREATE INDEX IF NOT EXISTS history_actions_order ON history_actions (tenant_id, log_id, visible, pending DESC, position DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS history_actions_version ON history_actions (tenant_id, log_id, version)`,
    `CREATE INDEX IF NOT EXISTS history_actions_time ON history_actions (tenant_id, log_id, timestamp)`,
    // The list pages by burst (see `refreshRuns` in history/action-index.ts), newest first.
    `CREATE INDEX IF NOT EXISTS history_actions_runs ON history_actions (tenant_id, log_id, visible, pending DESC, run_start DESC)`,
    `CREATE TABLE IF NOT EXISTS history_index_state (
        tenant_id TEXT NOT NULL,
        log_id TEXT NOT NULL,
        format INTEGER NOT NULL,
        built INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, log_id)
    )`,
    // An action's events, for indexing it and for showing its saved values.
    `CREATE INDEX IF NOT EXISTS idx_raw_events_scope_action ON raw_events (tenant_id, log_id, action_id)`,
];
