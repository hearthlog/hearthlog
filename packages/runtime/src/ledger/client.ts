import { loadLedgerConfig } from './config.js';
import { LedgerClient } from './http-client.js';

let client: LedgerClient | null = null;

/** The configured transport shared by this tab's default Ledger consumers. */
export function getLedgerClient(): LedgerClient {
    client ??= new LedgerClient(loadLedgerConfig());
    return client;
}
