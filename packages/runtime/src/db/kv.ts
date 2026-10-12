import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'kv-store';
const STORE_NAME = 'key-value';

let dbPromise: Promise<IDBPDatabase<unknown>> | null = null;

function getDb(): Promise<IDBPDatabase<unknown>> {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, 1, {
            upgrade(db) {
                db.createObjectStore(STORE_NAME);
            },
        });
    }
    return dbPromise;
}

export async function get<T>(key: string): Promise<T | null> {
    const db = await getDb();
    const value = await db.get(STORE_NAME, key);
    return value as T | null;
}

export async function set(key: string, value: unknown): Promise<void> {
    const db = await getDb();
    await db.put(STORE_NAME, value, key);
}

export async function del(key: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE_NAME, key);
}
