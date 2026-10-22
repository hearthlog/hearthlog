import { reconcileRestoredEvents } from '../history/legacy-replay.js';
/**
 * Read Model Rebuild
 * 
 * Functions for rebuilding the entire read model from the event store.
 */

import { db as readModelDB, ensureCoreSchema, recreateModuleProjectionTables, requireActiveContext } from '../db/index.js';
import type { Database, ActiveContext } from '../db/index.js';
import { sql, type Transaction } from 'kysely';
import { buildBulkProjectionSQL, type EntityProjectionConfig } from './projection-builder.js';
import { entityRegistry, getAllEntityTables } from './registry.js';
import { versionTracker } from '../ledger/version-tracker-singleton.js';
import { get as getKv, set as setKv } from '../db/kv.js';
import { SCHEMA_VERSION } from '../db/schema-version.js';
import { currentProjections, moduleTables, staleModules } from '../db/module-projections.js';
import { loadDynamicEntityTypes } from './dynamic-entities.js';
import { materializeDynamicEntities } from './dynamic-materializer.js';
import { withTiming } from '../utils/perf.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { postTabChange, SCHEMA_LOCK_NAME, withTabLock } from '../store/tab-coordination.js';

/**
 * Rebuilds the entire read model from raw_events
 * Uses the entity registry to iterate over all entities
 */
const SCHEMA_VERSION_KEY = 'schema-version';
/** Projection tables the stored read model was built for. */
const PROJECTED_TABLES_KEY = 'projected-tables';

export async function rebuildIfSchemaChanged(): Promise<boolean> {
    return withTiming('rebuild', 'rebuildIfSchemaChanged', async () => {
        // Ensure core tables (raw_events) have the latest columns
        const context = await requireActiveContext();
        await ensureCoreSchema({ tenantId: context.tenantId, logId: context.logId });

        // Always load dynamic entity types first - they need to be registered
        // before any event processing can happen
        await loadDynamicEntityTypes();

        // Tabs opening together decide inside one lock, so exactly one rebuilds
        // and the rest find the stored version current.
        return withTabLock(SCHEMA_LOCK_NAME, async () => {
            const storedVersion = await getKv<number>(SCHEMA_VERSION_KEY);
            // A re-enabled feature gets its projection table back empty; a build
            // with a different feature set re-projects like a schema change.
            const projectedTables = [...tenant.approvedEntities.tables].sort();
            const storedTables = await getKv<string[]>(PROJECTED_TABLES_KEY);
            const tablesUnchanged = JSON.stringify(storedTables) === JSON.stringify(projectedTables);

            // A module that raised its projection version re-projects like a schema change.
            const projections = currentProjections(tenant.features);
            const storedProjections = await readModelDB.selectFrom('module_migrations')
                .select(['module_id', 'projection_version']).execute();
            const stale = staleModules(storedProjections, projections);

            if (storedVersion === SCHEMA_VERSION && tablesUnchanged && stale.length === 0) {
                console.log('[Event] Schema version unchanged, skipping rebuild');
                return false;
            }

            console.log(`[Event] Schema version (${storedVersion} → ${SCHEMA_VERSION}), projected tables, or module projections (${stale.join(', ') || 'none'}) changed, rebuilding...`);
            // A module whose tables changed shape gets them recreated; no column repair is written.
            if (stale.length > 0) await recreateModuleProjectionTables(readModelDB, moduleTables(stale));
            await rebuildReadModel();
            await setKv(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
            await setKv(PROJECTED_TABLES_KEY, projectedTables);
            for (const { module, version } of projections) {
                await readModelDB.insertInto('module_migrations')
                    .values({ module_id: module, projection_version: version, applied_at: new Date().toISOString() })
                    .onConflict((conflict) => conflict.column('module_id').doUpdateSet({ projection_version: version, applied_at: new Date().toISOString() }))
                    .execute();
            }
            return true;
        });
    }, { currentVersion: SCHEMA_VERSION });
}

/**
 * Rebuilds the entire read model from raw events.
 * Uses the entity registry to iterate over all entities.
 * Only call this explicitly when needed - not on every app load!
 */
export async function rebuildReadModel(options: { includePendingDdl?: boolean } = {}): Promise<void> {
    return withTiming('rebuild', 'rebuildReadModel', async () => {
        console.log('[Event] Starting read model rebuild');
        const context = await requireActiveContext();

        // Definitions, DDL, restore membership, and all entity rows publish together.
        // Keep the tab-local registry unchanged until the database commit succeeds.
        await readModelDB.transaction().execute(tx => rebuildProjectionState(tx, context, options.includePendingDdl));
        await loadDynamicEntityTypes();

        // Rebuild entity version cache
        console.log('[Event] Rebuilding entity version cache');
        await versionTracker.rebuildVersionCache();

        // Other tabs hold stale registries and pages until told.
        postTabChange({ kind: 'rebuild', tenantId: context.tenantId, logId: context.logId });
        console.log('[Event] Read model rebuild completed successfully');
    }, { entityCount: Object.keys(entityRegistry).length });
}

/** Rebuild within the caller's publication transaction (checkpoint installation). */
export async function rebuildProjectionState(tx: Transaction<Database>, context: ActiveContext, includePendingDdl = false): Promise<void> {
    const staticConfigs = Object.values(entityRegistry).filter(entry => !entry.isDynamic).map(entry => entry.projection);
    const previousTables = getAllEntityTables();
    await reconcileRestoredEvents(tx, context, includePendingDdl);
    const dynamicConfigs = await rebuildDynamicDefinitions(tx, context, includePendingDdl);
    const configs = [...staticConfigs, ...dynamicConfigs];
    console.log('[Event] Clearing existing read model tables for active log');

    // Clear only this log's projection rows — leave other logs intact
    for (const table of new Set([...previousTables, ...configs.map(config => config.tableName)])) {
        await tx.deleteFrom(table as keyof Database)
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .execute();
    }
    await tx.deleteFrom('entity_versions')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .execute();
    console.log('[Event] Read model tables cleared for scope');

    // Rebuild each entity from events using the registry
    for (const config of configs) {
        await buildBulkProjectionSQL(config, context).execute(tx);
    }

}

/**
 * Rebuilds the entity_type_definitions table and dynamic registry
 * by replaying all definition events.
 */
async function rebuildDynamicDefinitions(tx: Transaction<Database>, context: ActiveContext, includePendingDdl = false): Promise<EntityProjectionConfig[]> {
    return withTiming('rebuild', 'rebuildDynamicDefinitions', async () => {
        console.log('[Event] Rebuilding dynamic entity definitions...');

        if (!tenant.dynamicEntities) {
            await tx.deleteFrom('entity_type_definitions')
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', context.logId)
                .execute();
            console.log('[Event] Dynamic entities disabled; definitions remain hidden');
            return [];
        }

        const stagedTable = '__stor_live_effective_events';
        try {
            await tx.deleteFrom('entity_type_definitions')
                .where('tenant_id', '=', context.tenantId)
                .where('log_id', '=', context.logId)
                .execute();
            await sql.raw(`DROP TABLE IF EXISTS temp."${stagedTable}"`).execute(tx);
            await sql`
                CREATE TEMP TABLE ${sql.raw(`"${stagedTable}"`)} AS
                SELECT * FROM main.projection_events
                WHERE tenant_id = ${context.tenantId}
                  AND log_id = ${context.logId}
                  AND (projection_state = 'effective' OR (${includePendingDdl ? 1 : 0} = 1 AND projection_state = 'pending_ddl'))
                  AND is_tombstoned = 0
            `.execute(tx);
            const result = await materializeDynamicEntities({
                database: tx,
                schema: 'main',
                sourceSchema: 'temp',
                sourceTable: stagedTable,
                scope: context,
                registerLive: false,
            });
            return result.activeProjectionConfigs;
        } finally {
            await sql.raw(`DROP TABLE IF EXISTS temp."${stagedTable}"`).execute(tx);
        }
    }, {});
}

export { versionTracker };
