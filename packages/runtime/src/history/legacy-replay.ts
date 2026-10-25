import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import { contiguousThrough } from '../store/sync-progress.js';
import { selectReplayEvents, WORKSPACE_RESTORED, EVENTS_EXCISED, type ReplayEvent } from '@hearthlog/contracts/history/replay-selection';

type ReplayDatabase = Kysely<Database> | Transaction<Database>;
type Scope = { tenantId: string; logId: string };

/** Restores and excisions both change replay membership without changing data. */
export async function hasReplayDirectives(database: ReplayDatabase, scope: Scope, through?: number): Promise<boolean> {
    let query = database.selectFrom('raw_events').select('id')
        .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
        .where('type', 'in', [WORKSPACE_RESTORED, EVENTS_EXCISED])
        .where('projection_state', 'in', ['effective', 'restored_out']);
    // An accepted boundary only counts directives up to that version; live
    // membership must also see pending local directives so a removal applies
    // before it uploads.
    if (through !== undefined) query = query.where('log_version', '<=', through);
    return Boolean(await query.executeTakeFirst());
}

/** Derive live projection membership; raw facts and immutable outbox bodies remain intact. */
export async function reconcileRestoredEvents(database: ReplayDatabase, scope: Scope, includePendingDdl = false): Promise<void> {
    if (!await hasReplayDirectives(database, scope)) return;
    const reconcile = async (tx: Transaction<Database>) => {
        const rows = await tx.selectFrom('raw_events').selectAll()
            .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
            .where('projection_state', 'in', includePendingDdl ? ['effective', 'restored_out', 'pending_ddl'] : ['effective', 'restored_out'])
            .orderBy('local_sequence').execute();
        // An installed baseline covers the positions up to its version; only the suffix is present here.
        const baseline = await tx.selectFrom('log_baselines').select('through_version')
            .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId).executeTakeFirst();
        const through = contiguousThrough(baseline?.through_version ?? 0, rows.flatMap(row => row.log_version === null ? [] : [row.log_version]));
        let pendingPosition = through;
        const replay: ReplayEvent[] = rows.filter(row => row.log_version === null || row.log_version <= through)
            .map(row => ({ id: row.id, type: row.type, payload: JSON.parse(row.payload),
                logVersion: row.log_version ?? ++pendingPosition }));
        const selected = selectReplayEvents(replay, pendingPosition).map(event => event.id);
        await tx.updateTable('raw_events').set({ projection_state: 'restored_out', is_tombstoned: 0 })
            .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
            .where('projection_state', 'in', ['effective', 'restored_out']).execute();
        for (let offset = 0; offset < selected.length; offset += 400) {
            await tx.updateTable('raw_events').set({ projection_state: 'effective' })
                .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId)
                .where('id', 'in', selected.slice(offset, offset + 400))
                .where('projection_state', 'in', ['effective', 'restored_out']).execute();
        }
        // Undo changes projection visibility, never delivery of the original
        // pending action. Its immutable upload still precedes its compensation.
        const selectedIds = new Set(selected);
        for (const row of rows.filter(row => row.log_version === null && row.projection_state !== 'pending_ddl')) {
            await tx.updateTable('raw_events').set({ projection_state: 'effective', is_tombstoned: selectedIds.has(row.id) ? 0 : 1 })
                .where('tenant_id', '=', scope.tenantId).where('log_id', '=', scope.logId).where('id', '=', row.id).execute();
        }
    };
    if (database.isTransaction) await reconcile(database as Transaction<Database>);
    else await database.transaction().execute(reconcile);
}

/** Apply the identical interpretation to an isolated, bounded snapshot table. */
export async function filterRestoredSnapshot(database: ReplayDatabase, table: string, boundary: number): Promise<void> {
    // table is a qualified identifier supplied by the snapshot builder, never user text.
    const rows = await sql<{ id: string; type: string; payload: string; log_version: number }>`
        SELECT id,type,payload,log_version FROM ${sql.raw(table)}
    `.execute(database);
    const selected = new Set(selectReplayEvents(rows.rows.map(row => ({ id: row.id, type: row.type,
        logVersion: row.log_version, payload: JSON.parse(row.payload) })), boundary).map(event => event.id));
    const removed = rows.rows.filter(row => !selected.has(row.id)).map(row => row.id);
    for (let offset = 0; offset < removed.length; offset += 400) {
        await sql`DELETE FROM ${sql.raw(table)} WHERE id IN (${sql.join(removed.slice(offset, offset + 400))})`.execute(database);
    }
}
