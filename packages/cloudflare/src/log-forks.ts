import { authorizeStorRequest } from './access-auth';
import { isUuid, verifyLogAppId } from './ledger-scope';
import type { FileContributor } from '@hearthlog/contracts';
import { planForkFiles } from './file-lifecycle';
import type { ReplayEvent } from '@hearthlog/contracts/history/replay-selection';

const ROUTE = /^\/api\/log-forks\/v1\/([0-9a-fA-F-]{36})\/prepare$/;
const PAGE_SIZE = 512;
const COPY_BATCH = 6;

type ForkEnv = Pick<Env, 'CF_ACCESS_APP_AUD' | 'CF_ACCESS_TEAM_DOMAIN' | 'STOR_AUTHORIZED_EMAILS'
    | 'LEDGER' | 'LEDGER_AUTH_TOKEN'>;
type StoredEvent = ReplayEvent & { entityId: string };

function error(status: number, code: string, message: string): Response {
    return Response.json({ error: message, code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function ledgerJson<T>(env: ForkEnv, path: string, method = 'GET'): Promise<T> {
    const response = await env.LEDGER.fetch(new Request(`https://ledger.internal${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}`, 'X-Ledger-Replay-Version': '2' },
    }));
    if (!response.ok) throw new Error(`Ledger returned ${response.status} while preparing this fork`);
    return await response.json() as T;
}

async function sourceEvents(env: ForkEnv, sourceId: string, through: number): Promise<StoredEvent[]> {
    const events: StoredEvent[] = [];
    let after = 0;
    while (after < through) {
        const page = await ledgerJson<{ events: Array<{
            id: string; type: string; version: number; entityId: string; payload: Record<string, unknown>;
        }> }>(env, `/logs/${sourceId}/events?afterVersion=${after}&limit=${PAGE_SIZE}`);
        const accepted = page.events.filter(event => event.version <= through);
        if (accepted.length === 0 || accepted[0]!.version !== after + 1) throw new Error('Source history is incomplete');
        for (const event of accepted) events.push({ ...event, logVersion: event.version });
        after = accepted.at(-1)!.version;
    }
    return events;
}

export async function handleForkPreparation(request: Request, env: ForkEnv, contributors: readonly FileContributor[]): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROUTE);
    if (!match || !isUuid(match[1]) || request.method !== 'POST') {
        return error(404, 'fork_route_not_found', 'Fork preparation route not found');
    }
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) {
        return error(403, 'origin_not_allowed', 'Cross-origin fork requests are not allowed');
    }
    try { await authorizeStorRequest(request, env); }
    catch { return error(403, 'fork_forbidden', 'Hearthlog access is required'); }
    if (!env.LEDGER_AUTH_TOKEN) return error(503, 'ledger_unconfigured', 'Ledger is unavailable');
    const childId = match[1];
    try {
        const appId = await verifyLogAppId(childId, env);
        const fork = await ledgerJson<{ sourceLogId: string | null; sourceVersion: number | null; status: string }>(
            env, `/logs/${childId}`);
        if (!fork.sourceLogId || fork.sourceVersion === null) return error(400, 'not_a_fork', 'This log is not a fork');
        if (fork.status === 'ready') return Response.json({ status: 'ready', remaining: 0 });
        if (fork.status !== 'preparing' || await verifyLogAppId(fork.sourceLogId, env) !== appId) {
            return error(403, 'fork_scope_mismatch', 'Fork source could not be verified');
        }
        const events = await sourceEvents(env, fork.sourceLogId, fork.sourceVersion);
        const manifest = planForkFiles(contributors, events, { appId, sourceLogId: fork.sourceLogId, childLogId: childId });
        let copied = 0;
        let remaining = 0;
        for (const ref of manifest) {
            // Contributors name the gateway's R2 bindings; a binding this site lacks is unavailable storage.
            const bucket = (env as unknown as Record<string, R2Bucket | undefined>)[ref.bucket];
            if (!bucket) return error(503, 'file_storage_unavailable', 'File storage is unavailable');
            if (await bucket.head(ref.childKey)) continue;
            const source = await bucket.get(ref.sourceKey);
            if (!source) {
                if (ref.required) return error(409, 'fork_file_missing', `A referenced file is missing: ${ref.sourceKey.split('/').at(-1)}`);
                continue;
            }
            if (copied >= COPY_BATCH) { remaining += 1; continue; }
            await bucket.put(ref.childKey, await source.arrayBuffer(), {
                httpMetadata: source.httpMetadata,
                customMetadata: source.customMetadata,
            });
            copied += 1;
        }
        if (remaining > 0) return Response.json({ status: 'preparing', copied, remaining });
        await ledgerJson(env, `/logs/${childId}/finalize-fork`, 'POST');
        return Response.json({ status: 'ready', copied, remaining: 0 });
    } catch (cause) {
        return error(503, 'fork_preparation_failed', cause instanceof Error ? cause.message : 'Could not prepare this fork');
    }
}
