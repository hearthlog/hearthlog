/**
 * Moves one Ledger application to another Ledger with every identity intact
 * (`GET .../transfer` on the source, `POST /admin/v1/import` and friends on the
 * destination), and proves the result. Pure over two administrator HTTP
 * callers, so the whole procedure runs in tests with no network.
 *
 * A new attempt first clears an unfinished import that an earlier, interrupted one left on the destination.
 * It only starts against a fenced source: an export taken while writes still
 * land would silently miss them. On any failure after the import began it
 * aborts the half-filled destination so the move can start over, and it never
 * touches the source.
 */

export type AdminCall = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<Response>;

export interface LogChecksum {
    id: string;
    headVersion: number;
    eventCount: number;
    sha256: string;
}

export interface MoveReport {
    appId: string;
    name: string;
    logs: number;
    events: number;
    requests: number;
    checksums: LogChecksum[];
    movedAt: string;
}

export interface MoveOptions {
    appId: string;
    source: AdminCall;
    target: AdminCall;
    /** Rehearsals against a copy may run without a fence; a real move never does. */
    allowUnfenced?: boolean;
    maxBatchRecords?: number;
    maxBatchBytes?: number;
    log?: (message: string) => void;
    now?: () => Date;
}

export class MoveError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'MoveError';
    }
}

type Line = { t: string } & Record<string, unknown>;

async function json<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new MoveError(`${what} failed with ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return (await response.json()) as T;
}

async function* lines(response: Response): AsyncGenerator<Line> {
    if (!response.body) throw new MoveError('The export has no body');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (value) pending += value;
        for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
            const text = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (text.trim()) yield JSON.parse(text) as Line;
        }
        if (done) break;
    }
    if (pending.trim()) yield JSON.parse(pending) as Line;
}

export function sameChecksums(source: readonly LogChecksum[], target: readonly LogChecksum[]): string[] {
    const problems: string[] = [];
    const left = new Map(source.map((log) => [log.id, log]));
    const right = new Map(target.map((log) => [log.id, log]));
    for (const [id, log] of left) {
        const other = right.get(id);
        if (!other) problems.push(`log ${id} is missing at the destination`);
        else if (other.headVersion !== log.headVersion || other.eventCount !== log.eventCount || other.sha256 !== log.sha256) {
            problems.push(`log ${id} differs: source ${log.eventCount} events at ${log.headVersion} (${log.sha256.slice(0, 12)}), destination ${other.eventCount} at ${other.headVersion} (${other.sha256.slice(0, 12)})`);
        }
    }
    for (const id of right.keys()) if (!left.has(id)) problems.push(`log ${id} exists only at the destination`);
    return problems;
}

export async function moveApplication(options: MoveOptions): Promise<MoveReport> {
    const { appId, source, target } = options;
    const log = options.log ?? (() => undefined);
    const maxRecords = options.maxBatchRecords ?? 200;
    const maxBytes = options.maxBatchBytes ?? 1_500_000;

    if (!options.allowUnfenced) {
        const state = await json<{ fence: { mode: string } | null }>(await source('GET', `/admin/v1/apps/${appId}/fence`), 'Reading the source fence');
        if (state.fence?.mode !== 'tenant_migrating') {
            throw new MoveError('The source is not fenced. Pause its writes first (mode "tenant_migrating"), or the copy would miss them.');
        }
    }

    const exported = await source('GET', `/admin/v1/apps/${appId}/transfer`);
    if (!exported.ok) {
        const detail = await exported.text().catch(() => '');
        throw new MoveError(`Exporting the source failed with ${exported.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }

    // An earlier attempt that lost its connection could not abort itself, and leaves an unfinished import that refuses
    // a new one. Aborting is safe here: it only acts on an import in progress and refuses a finished one.
    await target('POST', `/admin/v1/apps/${appId}/import/abort`).catch(() => undefined);

    let begun = false;
    try {
        let app: Line | null = null;
        let end: Line | null = null;
        const heads: Array<{ id: string; headVersion: number }> = [];
        let batch: Line[] = [];
        let batchBytes = 0;
        const counted = { logs: 0, events: 0, requests: 0 };

        const flush = async () => {
            if (batch.length === 0) return;
            await json(await target('POST', `/admin/v1/apps/${appId}/import`, { records: batch }), 'Importing a chunk');
            batch = [];
            batchBytes = 0;
        };

        for await (const line of lines(exported)) {
            if (line.t === 'app') {
                if (app) throw new MoveError('The export names two applications');
                if (line.id !== appId) throw new MoveError(`The export is for ${String(line.id)}, not ${appId}`);
                app = line;
                await json(await target('POST', '/admin/v1/import', { id: appId, name: line.name, createdAt: line.createdAt, policy: line.policy ?? null }), 'Starting the import');
                begun = true;
                log(`importing "${String(line.name)}" (${appId})`);
                continue;
            }
            if (!app) throw new MoveError('The export does not start with the application');
            if (line.t === 'end') {
                end = line;
                continue;
            }
            if (end) throw new MoveError('The export continues after its end');
            if (line.t === 'log') {
                heads.push({ id: String(line.id), headVersion: Number(line.headVersion) });
                counted.logs += 1;
            } else if (line.t === 'events') {
                counted.events += (line.events as unknown[]).length;
            } else if (line.t === 'requests') {
                counted.requests += (line.requests as unknown[]).length;
            }
            const size = JSON.stringify(line).length;
            if (batch.length > 0 && (batch.length >= maxRecords || batchBytes + size > maxBytes)) await flush();
            batch.push(line);
            batchBytes += size;
        }
        if (!app || !end) throw new MoveError('The export was cut short: it has no end record');
        for (const key of ['logs', 'events', 'requests'] as const) {
            if (Number(end[key]) !== counted[key]) throw new MoveError(`The export says ${String(end[key])} ${key} but carried ${counted[key]}`);
        }
        await flush();

        await json(await target('POST', `/admin/v1/apps/${appId}/import/finish`, { logs: heads }), 'Finishing the import');
        const [before, after] = await Promise.all([
            json<{ logs: LogChecksum[] }>(await source('GET', `/admin/v1/apps/${appId}/checksums`), 'Reading the source checksums'),
            json<{ logs: LogChecksum[] }>(await target('GET', `/admin/v1/apps/${appId}/checksums`), 'Reading the destination checksums'),
        ]);
        const problems = sameChecksums(before.logs, after.logs);
        if (problems.length) {
            // The destination is open now and cannot be aborted: the operator must discard it.
            throw new MoveError(`The destination differs from the source:\n  - ${problems.join('\n  - ')}`);
        }
        log(`verified ${before.logs.length} log(s), ${counted.events} event(s)`);
        return {
            appId, name: String(app.name), ...counted, checksums: after.logs, movedAt: (options.now ?? (() => new Date()))().toISOString(),
        };
    } catch (error) {
        if (begun) {
            // Best effort: a finished import refuses this, and then the error above says what differs.
            await target('POST', `/admin/v1/apps/${appId}/import/abort`).catch(() => undefined);
        }
        throw error;
    }
}
