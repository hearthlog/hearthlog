import { handleIncomingStoredEvents } from '../event/index.js';
import type { StoredEvent } from '../ledger/types.js';
import { notifyEventsChanged } from '../store/events.svelte.js';
import { db } from '../db/index.js';
import { sql } from 'kysely';

export interface StorE2ESeedApi {
    seedSyncedEvents(events: StoredEvent[]): Promise<{ hasNewEvents: boolean; newCount: number }>;
    resetDatabase(): Promise<void>;
}

export function installE2ESeedHelper(): void {
    if (import.meta.env.VITE_E2E !== '1' || typeof window === 'undefined') return;
    window.__storE2E = {
        async resetDatabase() {
            const tables = await sql<{ name: string }>`
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            `.execute(db);
            await sql.raw('PRAGMA foreign_keys = OFF').execute(db);
            try {
                await db.transaction().execute(async (tx) => {
                    for (const { name } of tables.rows) {
                        const quoted = `"${name.replace(/"/g, '""')}"`;
                        await sql.raw(`DELETE FROM ${quoted}`).execute(tx);
                    }
                });
            } finally {
                await sql.raw('PRAGMA foreign_keys = ON').execute(db);
            }
        },
        async seedSyncedEvents(events) {
            const cloned = structuredClone(events).sort((left, right) => left.version - right.version);
            const result = await handleIncomingStoredEvents(cloned);
            notifyEventsChanged();
            return result;
        },
    };
}
