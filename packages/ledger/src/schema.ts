const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
`;

const LEDGER_APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    app_id TEXT NOT NULL,
    name TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_generation INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    token_created_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_updated_at TEXT
);
CREATE TABLE IF NOT EXISTS log_events (
    log_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_version INTEGER NOT NULL,
    event_timestamp TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (log_id, version),
    UNIQUE (log_id, event_id)
);
CREATE INDEX IF NOT EXISTS log_events_entity_idx
    ON log_events(log_id, entity_id, entity_version);
CREATE TABLE IF NOT EXISTS entity_claims (
    log_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    current_version INTEGER NOT NULL,
    version_created INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (log_id, entity_id)
);
CREATE TABLE IF NOT EXISTS append_requests (
    request_id TEXT NOT NULL,
    log_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (request_id, log_id)
);
CREATE TABLE IF NOT EXISTS socket_tickets (
    nonce TEXT PRIMARY KEY,
    log_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_generation INTEGER NOT NULL,
    after_version INTEGER NOT NULL,
    origin TEXT,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
);
`;

const DROP_SOCKET_TICKETS = `
DROP TABLE IF EXISTS socket_tickets;
DROP INDEX IF EXISTS log_events_entity_idx;
`;

const APP_REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    active_principal_id TEXT NOT NULL,
    principal_generation INTEGER NOT NULL,
    active_token_created_at TEXT,
    provisioning_state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS applications_created_idx ON applications(created_at);
`;

interface Migration {
    id: number;
    sql: string;
}

const LEDGER_APP_MIGRATIONS: readonly Migration[] = [
    { id: 1, sql: LEDGER_APP_SCHEMA },
    { id: 2, sql: DROP_SOCKET_TICKETS },
    { id: 3, sql: `
        ALTER TABLE log_events ADD COLUMN action_id TEXT;
        ALTER TABLE log_events ADD COLUMN action_index INTEGER;
        ALTER TABLE log_events ADD COLUMN action_size INTEGER;
        CREATE UNIQUE INDEX log_events_action_position
            ON log_events(log_id, action_id, action_index) WHERE action_id IS NOT NULL;
    ` },
    { id: 4, sql: `
        ALTER TABLE logs ADD COLUMN source_log_id TEXT;
        ALTER TABLE logs ADD COLUMN source_version INTEGER;
        ALTER TABLE logs ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
        CREATE TABLE log_fork_requests (
            request_id TEXT PRIMARY KEY,
            source_log_id TEXT NOT NULL,
            target_version INTEGER NOT NULL,
            expected_source_head_version INTEGER NOT NULL,
            name TEXT NOT NULL,
            fork_log_id TEXT NOT NULL UNIQUE
        );
        CREATE INDEX logs_source_idx ON logs(source_log_id);
    ` },
    // Replay compatibility checks run on every read, append and socket
    // delivery. This partial index holds only restore and removal markers.
    { id: 5, sql: `
        CREATE INDEX log_events_replay_markers
            ON log_events(log_id, event_type)
            WHERE event_type IN ('WORKSPACE_RESTORED', 'EVENTS_EXCISED');
    ` },
    { id: 6, sql: `
        CREATE TABLE gallery_photo_references (
            log_id TEXT NOT NULL,
            photo_id TEXT NOT NULL,
            file_version_id TEXT NOT NULL,
            source_version INTEGER NOT NULL,
            PRIMARY KEY (log_id, photo_id, file_version_id)
        );
        CREATE INDEX gallery_photo_references_file_idx
            ON gallery_photo_references(photo_id, file_version_id);
    ` },
    // Clients close their stream while hidden, so live sockets alone rarely
    // show who uses an application. The administrator console lists the most
    // recent sessions; LedgerApp keeps this table bounded.
    { id: 7, sql: `
        CREATE TABLE socket_sessions (
            connection_id TEXT PRIMARY KEY,
            log_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            principal_generation INTEGER NOT NULL,
            connected_at TEXT NOT NULL,
            disconnected_at TEXT,
            close_code INTEGER,
            cursor INTEGER NOT NULL,
            last_sent_at TEXT,
            user_agent TEXT,
            ip TEXT,
            country TEXT,
            colo TEXT
        );
        CREATE INDEX socket_sessions_connected_idx
            ON socket_sessions(connected_at);
    ` },
    // Hiding is a presentation choice for the log tree. A null value keeps
    // older Workers and restored backups showing every log.
    { id: 8, sql: `
        ALTER TABLE logs ADD COLUMN hidden_at TEXT;
    ` },
    // An accepted append's events already live in log_events; its replay
    // needs only their version range. Older rows keep the full response.
    { id: 9, sql: `
        ALTER TABLE append_requests ADD COLUMN first_version INTEGER;
        ALTER TABLE append_requests ADD COLUMN last_version INTEGER;
    ` },
    // Who wrote an event: the identity the frontend Worker verified. Null for
    // events accepted before this column existed or without a stamped identity;
    // earlier code ignores the column during a rollback.
    { id: 10, sql: `
        ALTER TABLE log_events ADD COLUMN actor TEXT;
    ` },
    // What the application may append (see event-validation.ts). Null keeps
    // the behavior applications had before policies, and earlier code ignores the column.
    { id: 11, sql: `
        ALTER TABLE app_metadata ADD COLUMN event_policy TEXT;
    ` },
    // 'importing' while an identity-preserving import fills the application;
    // null otherwise, so earlier code never sees a value it does not know.
    { id: 12, sql: `
        ALTER TABLE app_metadata ADD COLUMN import_state TEXT;
    ` },
    // The write fence of a tenant move (see fence.ts). Null means writable, and
    // earlier code ignores the columns.
    { id: 13, sql: `
        ALTER TABLE app_metadata ADD COLUMN fence_mode TEXT;
        ALTER TABLE app_metadata ADD COLUMN fence_destination TEXT;
    ` },
];

const APP_REGISTRY_MIGRATIONS: readonly Migration[] = [
    { id: 1, sql: APP_REGISTRY_SCHEMA },
];

export function migrateLedgerApp(storage: DurableObjectStorage): void {
    migrate(storage, LEDGER_APP_MIGRATIONS);
}

export function migrateAppRegistry(storage: DurableObjectStorage): void {
    migrate(storage, APP_REGISTRY_MIGRATIONS);
}

function migrate(
    storage: DurableObjectStorage,
    migrations: readonly Migration[],
): void {
    storage.transactionSync(() => {
        storage.sql.exec(MIGRATIONS_TABLE);
        const applied = new Set(
            storage.sql
                .exec<{ id: number }>(
                    "SELECT id FROM _sql_schema_migrations ORDER BY id",
                )
                .toArray()
                .map(({ id }) => id),
        );

        let previousId = 0;
        for (const migration of migrations) {
            if (migration.id <= previousId) {
                throw new Error("schema migrations must be strictly ordered");
            }
            previousId = migration.id;
            if (applied.has(migration.id)) continue;

            storage.sql.exec(migration.sql);
            storage.sql.exec(
                `INSERT INTO _sql_schema_migrations (id, applied_at)
                 VALUES (?, ?)`,
                migration.id,
                new Date().toISOString(),
            );
        }
    });
}
