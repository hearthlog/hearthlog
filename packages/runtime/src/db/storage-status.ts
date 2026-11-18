import { DATABASE_PATH, sqlocalDb } from './index.js';
import { describeVfsChoice, preferredOpfsVfs, type OpfsVfs } from './opfs-vfs.js';

/**
 * Where the local database really lives. SQLocal falls back to an in-memory database without telling anyone when it
 * cannot open the OPFS file, and then every launch downloads and rebuilds everything; this is what the developer page
 * reads to show that, next to the facts that explain it.
 */
export interface StorageStatus {
    /** What SQLocal reports: `opfs`, `opfs-wl`, `memory`, or `local`/`session` in e2e builds. */
    storageType: string | null;
    requestedVfs: OpfsVfs;
    /** Why `requestedVfs` was chosen. */
    vfsReason: string;
    databasePath: string;
    /** SQLite's own idea of the database size. */
    sqliteBytes: number | null;
    /** The database file in the origin private file system, read directly. */
    file: { size: number; lastModified: number } | null;
    fileError: string | null;
    persisted: boolean | null;
    quota: { usage: number; quota: number } | null;
    checks: StorageCheck[];
}

export interface StorageCheck {
    label: string;
    ok: boolean;
}

export function isSavedStorage(storageType: string | null): boolean {
    return storageType === 'opfs' || storageType === 'opfs-wl';
}

/** The storage type of the open database, or null when SQLocal cannot say. */
export async function currentStorageType(): Promise<string | null> {
    try {
        return (await sqlocalDb.getDatabaseInfo()).storageType ?? null;
    } catch {
        return null;
    }
}

async function readDatabaseFile(): Promise<{ file: StorageStatus['file']; error: string | null }> {
    try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(DATABASE_PATH);
        const file = await handle.getFile();
        return { file: { size: file.size, lastModified: file.lastModified }, error: null };
    } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'NotFoundError') return { file: null, error: 'No database file in OPFS' };
        // A worker holding the file's sync access handle can make the read fail for a moment.
        return { file: null, error: cause instanceof Error ? cause.message : 'Could not read the database file' };
    }
}

export async function loadStorageStatus(): Promise<StorageStatus> {
    const [info, file, persisted, estimate] = await Promise.all([
        sqlocalDb.getDatabaseInfo().catch(() => null),
        typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' ? readDatabaseFile() : Promise.resolve({ file: null, error: 'OPFS is not available' }),
        navigator.storage?.persisted?.().catch(() => null) ?? Promise.resolve(null),
        navigator.storage?.estimate?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    const globals = globalThis as typeof globalThis & { crossOriginIsolated?: boolean };
    return {
        storageType: info?.storageType ?? null,
        requestedVfs: preferredOpfsVfs(),
        vfsReason: describeVfsChoice(),
        databasePath: DATABASE_PATH,
        sqliteBytes: typeof info?.databaseSizeBytes === 'number' ? info.databaseSizeBytes : null,
        file: file.file,
        fileError: file.error,
        persisted,
        quota: estimate ? { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 } : null,
        checks: [
            { label: 'Cross-origin isolated', ok: globals.crossOriginIsolated === true },
            { label: 'SharedArrayBuffer', ok: typeof SharedArrayBuffer !== 'undefined' },
            { label: 'Atomics.waitAsync', ok: typeof (Atomics as typeof Atomics & { waitAsync?: unknown }).waitAsync === 'function' },
            { label: 'Web Locks', ok: typeof navigator !== 'undefined' && 'locks' in navigator },
            { label: 'OPFS', ok: typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' },
        ],
    };
}

/** Ask the browser not to evict this site's storage under pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        return await navigator.storage.persist();
    } catch {
        return false;
    }
}
