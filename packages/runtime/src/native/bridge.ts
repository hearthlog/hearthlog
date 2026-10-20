/**
 * The native engine bridge, version 2: how a native app reads the runtime that a hidden web view
 * runs on the engine route (`ENGINE_PATH`). It knows no module. The app calls functions by name
 * through `window.hearthlogNative.call(name, argsJson)` and gets one JSON reply string back; the
 * engine posts `native:*` messages on the `stor` handler (`./engine.svelte.ts`).
 *
 * Only named handlers dispatch. Arguments arrive as JSON text and replies leave as JSON text, so
 * nothing but plain data crosses, and WebKit's lossy object bridging never applies.
 */

export const NATIVE_BRIDGE_VERSION = 2;

/** The route a native app loads in its hidden engine web view. It renders nothing. */
export const ENGINE_PATH = '/native-engine';

export type NativeErrorCode = 'unknown_function' | 'invalid_arguments' | 'not_ready' | 'failed';

export type NativeReply =
    | { ok: true; value: unknown }
    | { ok: false; error: { code: NativeErrorCode; message: string } };

/** Thrown by a handler to answer with a specific code; any other error answers `failed`. */
export class NativeCallError extends Error {
    constructor(readonly code: NativeErrorCode, message: string) {
        super(message);
    }
}

export type NativeArguments = Readonly<Record<string, unknown>>;
export type NativeHandler = (args: NativeArguments) => unknown;

/** What the page installs as `window.hearthlogNative`. */
export interface NativeEndpoint {
    readonly version: number;
    call(name: string, argsJson?: string): Promise<string>;
}

/** Messages the engine posts to the app: `{ type, body }` on the `stor` handler. */
export type NativeMessage =
    | { type: 'native:ready'; body: { bridgeVersion: number; context: EngineContext; apis: Readonly<Record<string, number>> } }
    | { type: 'native:status'; body: EngineStatus }
    | { type: 'native:failed'; body: { message: string } };

export interface EngineContext {
    tenantId: string;
    title: string;
    origin: string;
    /** The open log, or null before one is chosen. */
    logId: string | null;
    logName: string | null;
}

export interface EngineStatus {
    /** `deriveSyncPhase`: offline, idle, syncing, pending, blocked, waiting, error or synced. */
    phase: string;
    ready: boolean;
    active: boolean;
    isOnline: boolean;
    isSyncing: boolean;
    hasCompletedSync: boolean;
    pendingUploads: number;
    needsAttention: number;
    errorMessage: string | null;
    /** ISO 8601, or null before the first sync. */
    lastSyncedAt: string | null;
    /** False while the Access session is expired; the app shows sign-in. */
    signedIn: boolean;
    logId: string | null;
}

export function createDispatcher(handlers: Readonly<Record<string, NativeHandler>>): (name: string, argsJson?: string) => Promise<string> {
    return async (name, argsJson) => JSON.stringify(await dispatch(handlers, name, argsJson));
}

async function dispatch(handlers: Readonly<Record<string, NativeHandler>>, name: unknown, argsJson: unknown): Promise<NativeReply> {
    if (typeof name !== 'string' || !Object.hasOwn(handlers, name)) {
        return failure('unknown_function', `No native function is named ${JSON.stringify(String(name))}.`);
    }
    let args: NativeArguments;
    try {
        args = parseArguments(argsJson);
    } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : 'The arguments are not valid JSON.');
    }
    try {
        const value = await handlers[name]!(args);
        return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
        if (error instanceof NativeCallError) return failure(error.code, error.message);
        return failure('failed', error instanceof Error ? error.message : String(error));
    }
}

function parseArguments(argsJson: unknown): NativeArguments {
    if (argsJson === undefined || argsJson === null || argsJson === '') return {};
    if (typeof argsJson !== 'string') throw new Error('Arguments are sent as JSON text.');
    const value: unknown = JSON.parse(argsJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments are a JSON object.');
    return value as NativeArguments;
}

function failure(code: NativeErrorCode, message: string): NativeReply {
    return { ok: false, error: { code, message } };
}

/** Reads one boolean argument, or answers `invalid_arguments`. */
export function booleanArgument(args: NativeArguments, key: string): boolean {
    const value = args[key];
    if (typeof value !== 'boolean') throw new NativeCallError('invalid_arguments', `${key} must be true or false.`);
    return value;
}
