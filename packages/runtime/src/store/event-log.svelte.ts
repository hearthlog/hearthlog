import { get, set as setKv } from '../db/kv.js';
import { getLedgerClient } from '../ledger/index.js';
import { getLedgerCacheKey } from './local-context.js';

interface CachedLogSelection {
    logId: string;
    logName: string | null;
}

const LEGACY_SELECTION_MIGRATED_KEY = 'ledger-selected-log-migrated';

class EventLogStore {
    #value = $state<string | null>(null);
    #logName = $state<string | null>(null);
    #isInitialized = $state(false);
    #initializationPromise: Promise<void>;

    constructor() {
        this.#initializationPromise = this.initialize();
    }

    async initialize() {
        try {
            const selectionKey = await getLedgerCacheKey('selected-log');
            const cachedSelection = await get<CachedLogSelection>(selectionKey);
            let logId = cachedSelection?.logId ?? null;
            let logName = cachedSelection?.logName ?? null;

            if (!cachedSelection && !(await get<boolean>(LEGACY_SELECTION_MIGRATED_KEY))) {
                logId = await get<string>('event-log-id');
                logName = await get<string>('event-log-name');
                if (logId) {
                    await setKv(selectionKey, { logId, logName });
                }
                await setKv(LEGACY_SELECTION_MIGRATED_KEY, true);
            }

            if (!logId) {
                try {
                    const client = getLedgerClient();
                    const logs = await client.listLogs();

                    if (logs.length > 0) {
                        // Prefer a log named 'default' if it exists
                        const defaultLog = logs.find(log => log.name === 'default');
                        const selectedLog = defaultLog || logs[0];

                        logId = selectedLog.id;
                        logName = selectedLog.name;
                        await this.set(logId, logName);
                        console.log(`Default event log set to: ${logName} (${logId})`);
                    } else {
                        // Auto-create a default log on first run
                        const defaultName = 'default';
                        try {
                            const response = await client.createLog({ name: defaultName });
                            logId = response.id;
                            logName = response.name || null;
                            await this.set(logId, logName ?? undefined);
                            console.log(`Created default event log in Ledger Service: ${logName} (${logId})`);
                        } catch (createErr) {
                            console.warn("Failed to auto-create default event log in Ledger Service:", createErr);
                            console.warn("No event logs found in Ledger Service. Please create one on the developer page.");
                        }
                    }
                } catch (error) {
                    console.error("Failed to initialize default event log:", error);
                }
            }

            this.#value = logId;
            this.#logName = logName;
        } finally {
            this.#isInitialized = true;
        }
    }

    async set(logId: string, logName?: string) {
        this.#value = logId;
        this.#logName = logName || null;
        await setKv(await getLedgerCacheKey('selected-log'), {
            logId,
            logName: logName || null,
        } satisfies CachedLogSelection);
        // Retain legacy keys for older builds sharing this browser profile.
        await setKv('event-log-id', logId);
        if (logName) {
            await setKv('event-log-name', logName);
        }
    }

    get value() {
        return this.#value;
    }

    get name() {
        return this.#logName;
    }

    get isInitialized() {
        return this.#isInitialized;
    }

    ready(): Promise<void> {
        return this.#initializationPromise;
    }
}

export const eventLogFilename = new EventLogStore();
