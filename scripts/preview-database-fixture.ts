import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    getAllEntityDDL,
    getAllEntityIndexDDL,
} from '#generated/schema';
import { SCHEMA_VERSION } from '@hearthlog/runtime/db/schema-version.js';
import { MODULE_PROJECTIONS } from '#generated/modules';

/**
 * Produces a deterministic, empty SQLite fixture for production-preview tests.
 * Seeding OPFS keeps cold-profile measurements focused on application startup,
 * not on Chromium's first-ever creation of several dozen schema objects.
 */
export function createPreviewDatabaseFixture(): Buffer {
    const directory = mkdtempSync(join(tmpdir(), 'stor-preview-'));
    const databasePath = join(directory, 'stor');
    const database = new DatabaseSync(databasePath);

    try {
        // Chromium's fresh ephemeral profiles can expose only a very small initial
        // OPFS allocation. A 512-byte SQLite page keeps this empty fixture below it.
        database.exec('PRAGMA page_size = 512');
        database.exec('BEGIN IMMEDIATE');
        for (const ddl of getAllEntityDDL()) database.exec(ddl);
        database.exec(`
            CREATE TABLE raw_events (
                id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'legacy-unassigned',
                log_id TEXT NOT NULL DEFAULT 'legacy-unassigned', local_batch_id TEXT NOT NULL,
                local_sequence INTEGER NOT NULL DEFAULT 0,
                action_id TEXT, action_index INTEGER, action_size INTEGER, actor TEXT,
                type TEXT NOT NULL,
                timestamp INTEGER NOT NULL, payload TEXT NOT NULL, entity_id TEXT,
                entity_version INTEGER, log_version INTEGER,
                sync_state TEXT NOT NULL DEFAULT 'pending',
                projection_state TEXT NOT NULL DEFAULT 'effective',
                rejection_code TEXT, rejection_detail TEXT,
                is_tombstoned INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (tenant_id, log_id, id)
            );
            CREATE TABLE entity_versions (
                tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, entity_id TEXT NOT NULL,
                current_version INTEGER NOT NULL, log_version INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, log_id, entity_id)
            );
            CREATE TABLE active_context (
                id INTEGER PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL,
                principal_id TEXT NOT NULL, log_id TEXT NOT NULL, ledger_origin TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE local_batches (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', replacement_for TEXT,
                created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE outbox_operations (
                id TEXT PRIMARY KEY, request_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
                log_id TEXT NOT NULL, batch_id TEXT NOT NULL, request_body TEXT NOT NULL,
                request_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0, rebase_count INTEGER NOT NULL DEFAULT 0,
                last_error_code TEXT, last_error_message TEXT, superseded_by TEXT,
                next_retry_at TEXT, created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE (tenant_id, log_id, request_id)
            );
            CREATE TABLE outbox_operation_items (
                operation_id TEXT NOT NULL, event_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                PRIMARY KEY (operation_id, ordinal)
            );
            CREATE TABLE log_sync_state (
                tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
                downloaded_head_version INTEGER NOT NULL DEFAULT 0,
                projected_head_version INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT,
                PRIMARY KEY (tenant_id, log_id)
            );
            CREATE TABLE resolution_actions (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, log_id TEXT NOT NULL,
                batch_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE module_migrations (
                module_id TEXT PRIMARY KEY, projection_version INTEGER NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE sync_logs (
                id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, type TEXT NOT NULL,
                message TEXT NOT NULL, details TEXT, created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE entity_type_definitions (
                tenant_id TEXT NOT NULL, log_id TEXT NOT NULL, id TEXT NOT NULL,
                name TEXT NOT NULL, display_name TEXT NOT NULL, table_name TEXT NOT NULL,
                fields_json TEXT NOT NULL, is_archived INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (tenant_id, log_id, id), UNIQUE (tenant_id, log_id, name),
                UNIQUE (tenant_id, log_id, table_name)
            );
            CREATE INDEX idx_raw_events_scope_order ON raw_events
                (tenant_id, log_id, log_version, local_sequence);
            CREATE INDEX idx_raw_events_batch ON raw_events
                (tenant_id, log_id, local_batch_id, local_sequence);
            CREATE INDEX idx_raw_events_timestamp ON raw_events (timestamp);
            CREATE INDEX idx_raw_events_type ON raw_events (type);
            CREATE INDEX idx_raw_events_entity_id ON raw_events (entity_id);
            CREATE INDEX idx_raw_events_type_ts ON raw_events (type, timestamp);
            CREATE INDEX idx_raw_events_entity_version ON raw_events (entity_id, entity_version);
            CREATE INDEX idx_raw_events_log_version ON raw_events (log_version);
            CREATE INDEX idx_local_batches_scope_status ON local_batches
                (tenant_id, log_id, status, created_at);
            CREATE INDEX idx_outbox_operations_scope_status ON outbox_operations
                (tenant_id, log_id, status, created_at);
            CREATE INDEX idx_outbox_operations_retry ON outbox_operations
                (tenant_id, log_id, status, next_retry_at);
            CREATE INDEX idx_sync_logs_timestamp ON sync_logs (timestamp DESC);
            CREATE INDEX idx_entity_type_definitions_scope_name ON entity_type_definitions
                (tenant_id, log_id, name);
        `);
        for (const ddl of getAllEntityIndexDDL()) database.exec(ddl);
        database.prepare(`
            INSERT INTO active_context (
                id, tenant_id, principal_id, log_id, ledger_origin, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?)
        `).run(
            'preview-app',
            'preview-principal',
            'preview-log',
            'https://ledger.test',
            '2026-01-01T00:00:00.000Z',
        );
        database.prepare(`
            INSERT INTO log_sync_state (
                tenant_id, log_id, downloaded_head_version,
                projected_head_version, last_synced_at
            ) VALUES (?, ?, 0, 0, NULL)
        `).run('preview-app', 'preview-log');
        // A current database has every module at the version the code runs.
        for (const { module, version } of MODULE_PROJECTIONS) {
            database.prepare('INSERT INTO module_migrations (module_id, projection_version) VALUES (?, ?)').run(module, version);
        }
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        database.exec('COMMIT');
        database.close();
        return readFileSync(databasePath);
    } finally {
        try {
            database.close();
        } catch {
            // It was already closed after a successful fixture build.
        }
        rmSync(directory, { recursive: true, force: true });
    }
}
