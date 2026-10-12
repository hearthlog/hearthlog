import { MODULE_LOCAL_STORES } from '#generated/modules';

export interface IndexedDbStoreStats {
    name: string;
    entries: number;
}

export interface IndexedDbDatabaseStats {
    name: string;
    label: string;
    stores: IndexedDbStoreStats[];
    measuresFiles: boolean;
    fileCount: number;
    pdfCount: number;
    isdocCount: number;
    fileBytes: number;
}

export interface IndexedDbStats {
    databases: IndexedDbDatabaseStats[];
    fileCount: number;
    fileBytes: number;
    originUsage: number | null;
    originQuota: number | null;
}

const knownDatabases: Record<string, { label: string; fileStore?: string; kinds?: boolean }> = {
    // The enabled modules name their own file databases (`localStores` in the manifest).
    ...Object.fromEntries(MODULE_LOCAL_STORES.map(({ database, ...store }) => [database, store])),
    'kv-store': { label: 'App settings' },
};

function openExistingDatabase(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            reject(new Error(`Timed out opening ${name}`));
        }, 5000);
        request.onupgradeneeded = () => {
            // A database disappeared after enumeration. Do not create it.
            request.transaction?.abort();
        };
        request.onsuccess = () => {
            clearTimeout(timer);
            if (expired) {
                request.result.close();
                return;
            }
            resolve(request.result);
        };
        request.onerror = () => {
            clearTimeout(timer);
            expired = true;
            reject(request.error ?? new Error(`Could not open ${name}`));
        };
        request.onblocked = () => {
            clearTimeout(timer);
            expired = true;
            reject(new Error(`${name} is blocked by another tab`));
        };
    });
}

function readStore(db: IDBDatabase, name: string, measureFiles: boolean, kinds: boolean): Promise<{
    entries: number; fileCount: number; pdfCount: number; isdocCount: number; fileBytes: number;
}> {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(name, 'readonly');
        const store = transaction.objectStore(name);
        const count = store.count();
        let fileCount = 0;
        let pdfCount = 0;
        let isdocCount = 0;
        let fileBytes = 0;
        if (measureFiles) {
            const cursor = store.openCursor();
            cursor.onsuccess = () => {
                const row = cursor.result;
                if (!row) return;
                const value = row.value as { blob?: unknown; kind?: string };
                if (value.blob instanceof Blob) {
                    fileCount += 1;
                    fileBytes += value.blob.size;
                    if (kinds) {
                        if (value.kind === 'isdoc') isdocCount += 1;
                        else pdfCount += 1; // Older originals have no kind field.
                    }
                }
                row.continue();
            };
        }
        transaction.oncomplete = () => resolve({
            entries: count.result,
            fileCount,
            pdfCount,
            isdocCount,
            fileBytes,
        });
        transaction.onerror = () => reject(transaction.error ?? new Error(`Could not read ${name}`));
        transaction.onabort = () => reject(transaction.error ?? new Error(`Could not read ${name}`));
    });
}

/** Read-only inventory. File bytes are Blob payloads, not an IndexedDB disk-size estimate. */
export async function loadIndexedDbStats(): Promise<IndexedDbStats> {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
        throw new Error('This browser cannot list IndexedDB databases.');
    }
    const discovered = await indexedDB.databases();
    const names = discovered.flatMap((database) => database.name ? [database.name] : []);
    const databases: IndexedDbDatabaseStats[] = [];
    for (const name of names.sort()) {
        const config = knownDatabases[name];
        const db = await openExistingDatabase(name);
        try {
            const stores: IndexedDbStoreStats[] = [];
            let fileCount = 0;
            let pdfCount = 0;
            let isdocCount = 0;
            let fileBytes = 0;
            for (const storeName of Array.from(db.objectStoreNames)) {
                const result = await readStore(db, storeName, config?.fileStore === storeName, config?.kinds === true);
                stores.push({ name: storeName, entries: result.entries });
                fileCount += result.fileCount;
                pdfCount += result.pdfCount;
                isdocCount += result.isdocCount;
                fileBytes += result.fileBytes;
            }
            databases.push({
                name,
                label: config?.label ?? name,
                stores,
                measuresFiles: !!config?.fileStore && stores.some((store) => store.name === config.fileStore),
                fileCount,
                pdfCount,
                isdocCount,
                fileBytes,
            });
        } finally {
            db.close();
        }
    }
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    return {
        databases,
        fileCount: databases.reduce((sum, database) => sum + database.fileCount, 0),
        fileBytes: databases.reduce((sum, database) => sum + database.fileBytes, 0),
        originUsage: estimate?.usage ?? null,
        originQuota: estimate?.quota ?? null,
    };
}
