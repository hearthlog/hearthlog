#!/usr/bin/env node
import { actionBatches, authorRuns, restoreBatchRequest } from '../src/action-batches.js';

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    AdminEventsResponse,
    ApplicationTokenResponse,
    AppendEventsResponse,
    CreateLogResponse,
    EventBatchResponse,
    JsonObject,
    LogListResponse,
    LogSummary,
    SessionResponse,
    StoredEvent,
} from '../src/schemas.js';

const FORMAT = 'ledger-logical-export';
const FORMAT_VERSION = 1;
const PAGE_SIZE = 512;

const [command, ...rawArgs] = process.argv.slice(2);
const options = parseOptions(rawArgs);

interface ApiOptions {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    allowFailure?: boolean;
}

interface ExportPage {
    file: string;
    afterVersion: number;
    throughVersion: number;
    count: number;
    sha256: string;
}

interface ExportedLog {
    sourceLogId: string;
    name: string;
    headVersion: number;
    parentSourceLogId?: string | null;
    sourceVersion?: number | null;
    /** The log was hidden; a restore hides it again (at the restore time). */
    hidden?: boolean;
    pages: ExportPage[];
}

interface UnsignedManifest {
    format: typeof FORMAT;
    version: typeof FORMAT_VERSION;
    exportedAt: string;
    sourceAppId: string;
    pageSize: typeof PAGE_SIZE;
    logs: ExportedLog[];
}

interface ExportManifest extends UnsignedManifest {
    manifestSha256: string;
}

try {
    if (command === 'export') {
        await exportLedger();
    } else if (command === 'restore') {
        await restoreLedger();
    } else {
        usage();
        process.exitCode = 2;
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

/**
 * Reads one application's logs and events. With `--app <id>` it reads through
 * the administrator API (LEDGER_ADMIN_TOKEN), so the application's own token is
 * neither needed nor rotated; otherwise it reads with LEDGER_AUTH_TOKEN.
 */
interface ExportSource {
    appId: string;
    logs: LogSummary[];
    /** Events after `afterVersion`, ascending, at most up to the log head. */
    events(log: LogSummary, afterVersion: number): Promise<StoredEvent[]>;
}

async function appTokenSource(baseUrl: string, token: string): Promise<ExportSource> {
    const session = await api<SessionResponse>(baseUrl, '/session', token);
    const { logs } = await api<LogListResponse>(baseUrl, '/logs', token);
    return {
        appId: session.appId,
        logs,
        async events(log, afterVersion) {
            const response = await api<EventBatchResponse>(
                baseUrl,
                `/logs/${log.id}/events?afterVersion=${afterVersion}&limit=${PAGE_SIZE}`,
                token,
            );
            return response.events.filter((event) => event.version <= log.headVersion);
        },
    };
}

async function administratorSource(baseUrl: string, adminToken: string, appId: string): Promise<ExportSource> {
    const { logs } = await api<LogListResponse>(baseUrl, `/admin/v1/apps/${appId}/logs`, adminToken);
    const cache = new Map<string, StoredEvent[]>();
    return {
        appId,
        logs,
        async events(log, afterVersion) {
            let all = cache.get(log.id);
            if (!all) {
                // The administrator API pages newest first, 100 at a time.
                all = [];
                let before: number | null = log.headVersion + 1;
                while (before !== null && before > 1) {
                    const response: AdminEventsResponse = await api<AdminEventsResponse>(
                        baseUrl,
                        `/admin/v1/apps/${appId}/logs/${log.id}/events?beforeVersion=${before}&limit=100`,
                        adminToken,
                    );
                    all.push(...response.events);
                    before = response.events.length === 0 ? null : response.nextBeforeVersion;
                }
                all = all.filter((event) => event.version <= log.headVersion).sort((a, b) => a.version - b.version);
                cache.set(log.id, all);
            }
            return all.filter((event) => event.version > afterVersion).slice(0, PAGE_SIZE);
        },
    };
}

async function exportLedger(): Promise<void> {
    const baseUrl = requiredEnv('LEDGER_BASE_URL').replace(/\/$/, '');
    const source = options.app
        ? await administratorSource(baseUrl, requiredEnv('LEDGER_ADMIN_TOKEN'), options.app)
        : await appTokenSource(baseUrl, requiredEnv('LEDGER_AUTH_TOKEN'));
    const output = path.resolve(options.output ?? `ledger-export-${Date.now()}`);
    await mkdir(output);

    const logs = source.logs;
    const manifest: UnsignedManifest = {
        format: FORMAT,
        version: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        sourceAppId: source.appId,
        pageSize: PAGE_SIZE,
        logs: [],
    };

    const skippedLogIds: string[] = [];
    for (const [logIndex, log] of logs.entries()) {
        // A fork waiting for its files cannot be read yet and has no children.
        if (log.status === 'preparing') {
            console.warn(`skipping fork ${log.id}: it is still being prepared`);
            skippedLogIds.push(log.id);
            continue;
        }
        const exportedLog: ExportedLog = {
            sourceLogId: log.id,
            name: log.name,
            headVersion: log.headVersion,
            parentSourceLogId: log.sourceLogId ?? null,
            sourceVersion: log.sourceVersion ?? null,
            ...(log.hiddenAt ? { hidden: true } : {}),
            pages: [],
        };
        let cursor = 0;
        let pageIndex = 0;
        while (cursor < log.headVersion) {
            const events = await source.events(log, cursor);
            assertContiguous(events, cursor, log.headVersion);
            if (events.length === 0) {
                throw new Error(`export stopped before ${log.id} reached version ${log.headVersion}`);
            }

            const content = encodePage(events);
            const file = `log-${logIndex + 1}-page-${pageIndex + 1}.ndjson`;
            await writeFile(path.join(output, file), content, { flag: 'wx', mode: 0o600 });
            const throughVersion = events.at(-1)!.version;
            exportedLog.pages.push({
                file,
                afterVersion: cursor,
                throughVersion,
                count: events.length,
                sha256: sha256(content),
            });
            cursor = throughVersion;
            pageIndex++;
        }
        manifest.logs.push(exportedLog);
    }

    const manifestSha256 = sha256(canonicalJson(manifest));
    await writeFile(
        path.join(output, 'manifest.json'),
        `${JSON.stringify({ ...manifest, manifestSha256 }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
    );
    console.log(JSON.stringify({ output, manifestSha256, logs: manifest.logs.length, skippedLogIds }, null, 2));
}

async function restoreLedger(): Promise<void> {
    const baseUrl = requiredEnv('LEDGER_BASE_URL').replace(/\/$/, '');
    const adminToken = requiredEnv('LEDGER_ADMIN_TOKEN');
    const input = path.resolve(requiredOption('input'));
    const { manifest, pagesByLog } = await validateExport(input);
    const name = options.name ?? `restore-${manifest.sourceAppId}-${Date.now()}`;

    let targetApp: ApplicationTokenResponse | undefined;
    try {
        targetApp = await api<ApplicationTokenResponse>(
            baseUrl,
            '/admin/v1/apps',
            adminToken,
            {
            method: 'POST',
            body: { name },
            },
        );
        const bootstrapToken = targetApp.token;
        const existing = await api<LogListResponse>(
            baseUrl,
            '/logs',
            bootstrapToken,
        );
        if (existing.logs.length !== 0) throw new Error('restore target is not empty');

        const logMappings: Array<{
            sourceLogId: string;
            targetLogId: string;
        }> = [];
        for (const [logIndex, sourceLog] of manifest.logs.entries()) {
            const targetLog = await api<CreateLogResponse>(
                baseUrl,
                '/logs',
                bootstrapToken,
                {
                    method: 'POST',
                    body: { name: sourceLog.name },
                },
            );
            logMappings.push({ sourceLogId: sourceLog.sourceLogId, targetLogId: targetLog.id });

            const sourcePages = pagesByLog[logIndex];
            if (!sourcePages) {
                throw new Error(`missing export pages for ${sourceLog.sourceLogId}`);
            }
            for (const batch of actionBatches(sourcePages.flat())) {
                for (const events of authorRuns(batch)) {
                    const response = await api<AppendEventsResponse>(
                        baseUrl,
                        `/logs/${targetLog.id}/events`,
                        bootstrapToken,
                        {
                            method: 'POST',
                            body: restoreBatchRequest(events, randomUUID()),
                            // A run is one replayed request, so its events share an author.
                            ...(events[0]?.actor ? { headers: { 'X-Ledger-Actor': events[0].actor } } : {}),
                        },
                    );
                    const expectedVersion = events.at(-1)!.version;
                    if (response.newVersion !== expectedVersion) {
                        throw new Error(
                            `restore version mismatch for ${sourceLog.sourceLogId}: ` +
                            `expected ${expectedVersion}, received ${response.newVersion}`,
                        );
                    }
                }
            }
            await verifyRestoredLog(baseUrl, bootstrapToken, targetLog.id, sourceLog);
        }

        const mappedLogs = new Map(logMappings.map(({ sourceLogId, targetLogId }) => [sourceLogId, targetLogId]));
        for (const sourceLog of manifest.logs) {
            if (!sourceLog.parentSourceLogId || sourceLog.sourceVersion === null || sourceLog.sourceVersion === undefined) continue;
            const targetLogId = mappedLogs.get(sourceLog.sourceLogId);
            const parentLogId = mappedLogs.get(sourceLog.parentSourceLogId);
            if (!targetLogId || !parentLogId) throw new Error(`missing fork lineage for ${sourceLog.sourceLogId}`);
            await api<LogSummary>(baseUrl,
                `/admin/v1/apps/${targetApp.app.id}/logs/${targetLogId}/lineage`, adminToken,
                { method: 'POST', body: { sourceLogId: parentLogId, sourceVersion: sourceLog.sourceVersion } },
            );
        }

        for (const sourceLog of manifest.logs) {
            if (!sourceLog.hidden) continue;
            const targetLogId = mappedLogs.get(sourceLog.sourceLogId)!;
            const hidden = await api<LogSummary>(baseUrl, `/logs/${targetLogId}/visibility`, bootstrapToken,
                { method: 'POST', body: { hidden: true } });
            if (!hidden.hiddenAt) throw new Error(`restored log ${targetLogId} did not stay hidden`);
        }

        const activated = await api<ApplicationTokenResponse>(
            baseUrl,
            `/admin/v1/apps/${targetApp.app.id}/rotate-token`,
            adminToken,
            { method: 'POST' },
        );
        console.log(JSON.stringify({
            app: activated.app,
            token: activated.token,
            sourceAppId: manifest.sourceAppId,
            manifestSha256: manifest.manifestSha256,
            logs: logMappings,
        }, null, 2));
    } catch (error) {
        if (targetApp?.app?.id) {
            await api(
                baseUrl,
                `/admin/v1/apps/${targetApp.app.id}/revoke`,
                adminToken,
                { method: 'POST', allowFailure: true },
            );
        }
        throw error;
    }
}

async function validateExport(input: string): Promise<{
    manifest: ExportManifest;
    pagesByLog: StoredEvent[][][];
}> {
    const manifest = parseManifest(
        JSON.parse(
            await readFile(path.join(input, 'manifest.json'), 'utf8'),
        ) as unknown,
    );
    if (manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION) {
        throw new Error('unsupported logical export format');
    }
    const { manifestSha256, ...unsignedManifest } = manifest;
    if (sha256(canonicalJson(unsignedManifest)) !== manifestSha256) {
        throw new Error('manifest checksum mismatch');
    }

    const logById = new Map(manifest.logs.map(log => [log.sourceLogId, log]));
    for (const log of manifest.logs) {
        if (!log.parentSourceLogId) {
            if (log.sourceVersion !== undefined && log.sourceVersion !== null) {
                throw new Error(`fork source version lacks a parent: ${log.sourceLogId}`);
            }
            continue;
        }
        const parent = logById.get(log.parentSourceLogId);
        if (!parent || log.sourceVersion === undefined || log.sourceVersion === null
            || log.sourceVersion > parent.headVersion || log.sourceVersion > log.headVersion) {
            throw new Error(`invalid fork lineage: ${log.sourceLogId}`);
        }
    }

    const pagesByLog: StoredEvent[][][] = [];
    for (const log of manifest.logs) {
        let cursor = 0;
        const pages: StoredEvent[][] = [];
        for (const page of log.pages) {
            const content = await readFile(safeExportPath(input, page.file), 'utf8');
            if (sha256(content) !== page.sha256) {
                throw new Error(`page checksum mismatch: ${page.file}`);
            }
            const events = content
                .split('\n')
                .filter(Boolean)
                .map((line) => parseStoredEvent(JSON.parse(line) as unknown));
            if (
                page.afterVersion !== cursor ||
                page.count !== events.length ||
                page.throughVersion !== events.at(-1)?.version
            ) {
                throw new Error(`invalid page metadata: ${page.file}`);
            }
            assertContiguous(events, cursor, log.headVersion);
            cursor = page.throughVersion;
            pages.push(events);
        }
        if (cursor !== log.headVersion) {
            throw new Error(`log ${log.sourceLogId} ends at ${cursor}, expected ${log.headVersion}`);
        }
        // Validate complete grouping before provisioning the restore destination.
        for (const _batch of actionBatches(pages.flat())) { /* validate */ }
        pagesByLog.push(pages);
    }
    return { manifest, pagesByLog };
}

async function verifyRestoredLog(
    baseUrl: string,
    token: string,
    targetLogId: string,
    sourceLog: ExportedLog,
): Promise<void> {
    for (const page of sourceLog.pages) {
        const response = await api<EventBatchResponse>(
            baseUrl,
            `/logs/${targetLogId}/events?afterVersion=${page.afterVersion}&limit=${page.count}`,
            token,
        );
        if (response.events.length !== page.count || sha256(encodePage(response.events)) !== page.sha256) {
            throw new Error(`post-restore verification failed for ${page.file}`);
        }
    }
    const target = await api<LogSummary>(
        baseUrl,
        `/logs/${targetLogId}`,
        token,
    );
    if (target.headVersion !== sourceLog.headVersion) {
        throw new Error(`restored log head mismatch for ${sourceLog.sourceLogId}`);
    }
}

async function api<T>(
    baseUrl: string,
    endpoint: string,
    token: string,
    options: ApiOptions = {},
): Promise<T> {
    const response = await fetch(`${baseUrl}${endpoint}`, {
        method: options.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            "X-Ledger-Replay-Version": "2",
            ...options.headers,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
        if (options.allowFailure) return null as T;
        const details = await response.text();
        throw new Error(`${options.method ?? 'GET'} ${endpoint} failed (${response.status}): ${details}`);
    }
    if (response.status === 204) return null as T;
    return (await response.json()) as T;
}

function assertContiguous(
    events: readonly StoredEvent[],
    afterVersion: number,
    maximumVersion: number,
): void {
    for (const [index, event] of events.entries()) {
        const expected = afterVersion + index + 1;
        if (!Number.isSafeInteger(event.version) || event.version !== expected) {
            throw new Error(`non-contiguous export page: expected ${expected}, received ${event.version}`);
        }
        if (event.version > maximumVersion) {
            throw new Error(`event version ${event.version} exceeds snapshot head ${maximumVersion}`);
        }
    }
}

function encodePage(events: readonly StoredEvent[]): string {
    return events.map(canonicalJson).join('\n') + (events.length > 0 ? '\n' : '');
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        )).join(',')}}`;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('value is not JSON serializable');
    return serialized;
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function safeExportPath(root: string, file: string): string {
    const resolved = path.resolve(root, file);
    if (path.dirname(resolved) !== root || path.basename(file) !== file) {
        throw new Error(`unsafe export page path: ${file}`);
    }
    return resolved;
}

function parseOptions(args: string[]): Record<string, string> {
    const parsed: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (!key?.startsWith('--') || value === undefined) {
            throw new Error(`invalid option list near ${key ?? '<end>'}`);
        }
        parsed[key.slice(2)] = value;
    }
    return parsed;
}

function parseManifest(value: unknown): ExportManifest {
    const manifest = recordValue(value, 'manifest');
    if (manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION) {
        throw new Error('unsupported logical export format');
    }
    if (manifest.pageSize !== PAGE_SIZE) {
        throw new Error('unsupported logical export page size');
    }
    return {
        format: FORMAT,
        version: FORMAT_VERSION,
        exportedAt: stringValue(manifest.exportedAt, 'manifest.exportedAt'),
        sourceAppId: stringValue(manifest.sourceAppId, 'manifest.sourceAppId'),
        pageSize: PAGE_SIZE,
        logs: arrayValue(manifest.logs, 'manifest.logs').map(
            (log, index) => parseExportedLog(log, index),
        ),
        manifestSha256: stringValue(
            manifest.manifestSha256,
            'manifest.manifestSha256',
        ),
    };
}

function parseExportedLog(value: unknown, index: number): ExportedLog {
    const label = `manifest.logs[${index}]`;
    const log = recordValue(value, label);
    return {
        sourceLogId: stringValue(log.sourceLogId, `${label}.sourceLogId`),
        name: stringValue(log.name, `${label}.name`),
        headVersion: nonnegativeInteger(
            log.headVersion,
            `${label}.headVersion`,
        ),
        ...(log.parentSourceLogId !== undefined ? {
            parentSourceLogId: log.parentSourceLogId === null ? null
                : stringValue(log.parentSourceLogId, `${label}.parentSourceLogId`),
        } : {}),
        ...(log.sourceVersion !== undefined ? {
            sourceVersion: log.sourceVersion === null ? null
                : nonnegativeInteger(log.sourceVersion, `${label}.sourceVersion`),
        } : {}),
        ...(log.hidden !== undefined ? { hidden: booleanValue(log.hidden, `${label}.hidden`) } : {}),
        pages: arrayValue(log.pages, `${label}.pages`).map(
            (page, pageIndex) => parseExportPage(page, label, pageIndex),
        ),
    };
}

function parseExportPage(
    value: unknown,
    logLabel: string,
    index: number,
): ExportPage {
    const label = `${logLabel}.pages[${index}]`;
    const page = recordValue(value, label);
    return {
        file: stringValue(page.file, `${label}.file`),
        afterVersion: nonnegativeInteger(
            page.afterVersion,
            `${label}.afterVersion`,
        ),
        throughVersion: nonnegativeInteger(
            page.throughVersion,
            `${label}.throughVersion`,
        ),
        count: nonnegativeInteger(page.count, `${label}.count`),
        sha256: stringValue(page.sha256, `${label}.sha256`),
    };
}

function parseStoredEvent(value: unknown): StoredEvent {
    const event = recordValue(value, 'stored event');
    const action = event.action === undefined ? undefined : recordValue(event.action, 'stored event.action');
    return {
        ...(action ? { action: {
            id: stringValue(action.id, 'action.id'),
            index: nonnegativeInteger(action.index, 'action.index'),
            size: positiveInteger(action.size, 'action.size'),
        } } : {}),
        version: positiveInteger(event.version, 'stored event.version'),
        id: stringValue(event.id, 'stored event.id'),
        type: stringValue(event.type, 'stored event.type'),
        entityId: stringValue(event.entityId, 'stored event.entityId'),
        entityVersion: positiveInteger(
            event.entityVersion,
            'stored event.entityVersion',
        ),
        timestamp: nonnegativeInteger(
            event.timestamp,
            'stored event.timestamp',
        ),
        payload: recordValue(
            event.payload,
            'stored event.payload',
        ) as JsonObject,
        ...(event.actor === undefined ? {} : { actor: stringValue(event.actor, 'stored event.actor') }),
    };
}

function recordValue(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

function booleanValue(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    return value;
}

function stringValue(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value as number;
}

function positiveInteger(value: unknown, label: string): number {
    const parsed = nonnegativeInteger(value, label);
    if (parsed < 1) throw new Error(`${label} must be positive`);
    return parsed;
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function requiredOption(name: string): string {
    const value = options[name];
    if (!value) throw new Error(`--${name} is required`);
    return value;
}

function usage(): void {
    console.error(`Usage:
  LEDGER_BASE_URL=... LEDGER_AUTH_TOKEN=... pnpm ledger:export --output DIR
  LEDGER_BASE_URL=... LEDGER_ADMIN_TOKEN=... pnpm ledger:export --app APP_ID --output DIR
  LEDGER_BASE_URL=... LEDGER_ADMIN_TOKEN=... pnpm ledger:restore --input DIR [--name NAME]`);
}
