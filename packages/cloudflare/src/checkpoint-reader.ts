import { checkpointDigest, verifyCheckpointManifest, type CheckpointChunk, type CheckpointEvent, type LogMaintenance } from '@hearthlog/contracts/history/checkpoint';
import { isUuid, LedgerScopeError, type LedgerScopeEnv } from './ledger-scope.js';

/** Read a scoped, verified baseline for server projections. Old Ledgers keep full replay. */
export async function readLedgerCheckpoint(env: LedgerScopeEnv, logId: string, through: number,
    session: { appId: string; capabilities?: string[] }): Promise<{ throughVersion: number; events: CheckpointEvent[] } | null> {
    if (!session.capabilities?.includes('snapshot-baseline-v1')) return null;
    if (!isUuid(logId) || !Number.isSafeInteger(through) || through < 0) throw new LedgerScopeError(400, 'invalid_checkpoint_scope', 'Choose a valid log boundary');
    async function read<T>(path: string): Promise<T> {
        const response = await env.LEDGER.fetch(new Request(`https://ledger.internal${path}`, {
            headers: { Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}`, 'X-Ledger-Replay-Version': '2' },
        }));
        if (!response.ok) throw new LedgerScopeError(503, 'checkpoint_unavailable', 'The log snapshot could not be verified');
        return response.json() as Promise<T>;
    }
    const state = await read<LogMaintenance>(`/logs/${logId}/maintenance`);
    const manifest = state.checkpoint;
    if (!manifest || manifest.throughVersion > through) return null;
    verifyCheckpointManifest(manifest, session.appId, logId);
    if (await checkpointDigest(JSON.stringify(manifest.pages)) !== manifest.sha256) throw new Error('Invalid snapshot manifest digest');
    const events: CheckpointEvent[] = [];
    for (const [index, page] of manifest.pages.entries()) {
        const chunk = await read<CheckpointChunk>(`/logs/${logId}/checkpoint?page=${index}`);
        if (await checkpointDigest(JSON.stringify(chunk)) !== page.sha256 || chunk.events.length !== page.count) throw new Error('Snapshot page checksum mismatch');
        for (const event of chunk.events) {
            if (event.version < 1 || event.version > manifest.throughVersion) throw new Error('Invalid snapshot event boundary');
            events.push(event);
        }
    }
    return { throughVersion: manifest.throughVersion, events: events.sort((a, b) => a.version - b.version) };
}
