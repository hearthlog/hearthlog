/**
 * What the Ledger's admin API returns for connections, and the markers of its SQL export, as plain
 * types: the Ledger Worker checks its schemas against them (`ledger/src/schemas.ts`), and the
 * browser (the runtime's admin client, the admin console) imports them without the Worker's code.
 */

export type AdminConnectionState = 'connecting' | 'open' | 'closing' | 'closed';

export interface AdminConnectionClient {
    userAgent: string | null;
    ip: string | null;
    country: string | null;
    colo: string | null;
}

export interface AdminConnection {
    id: string;
    logId: string;
    logName: string | null;
    principalId: string;
    generation: number;
    state: AdminConnectionState;
    cursor: number;
    headVersion: number | null;
    connectedAt: string | null;
    lastSentAt: string | null;
    client: AdminConnectionClient;
}

export interface AdminRecentConnection {
    id: string;
    logId: string;
    logName: string | null;
    principalId: string;
    generation: number;
    cursor: number;
    connectedAt: string;
    disconnectedAt: string | null;
    closeCode: number | null;
    lastSentAt: string | null;
    client: AdminConnectionClient;
}

export interface AdminConnectionsResponse {
    sampledAt: string;
    total: number;
    unavailable: number;
    connections: AdminConnection[];
    nextAfterId: string | null;
    recent: AdminRecentConnection[];
}

// The browser can consume the same SQL dump a SQLite CLI can restore. Statement
// boundaries let the export worker import incrementally without parsing SQL.
export const SQL_EXPORT_BOUNDARY = '\n-- ledger-export-statement\n';
export const SQL_EXPORT_COMPLETE = '-- ledger-sqlite-export-complete\n';
