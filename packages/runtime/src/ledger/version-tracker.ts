import { rebuildCheckpointVersions } from '../history/baseline.js';
/**
 * Entity Version Tracker
 * 
 * Tracks entity versions in the local read model to support optimistic locking.
 * Maintains a cache of current entity versions for fast lookups during event appends.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import { requireActiveContext, type Database } from '../db/index.js';
import type { StoredEvent } from './types.js';

/**
 * Record accepted entity versions in one statement, in the caller's transaction. SQLite resolves repeated entities
 * and older notifications monotonically.
 */
export async function writeEntityVersions(
  executor: Kysely<Database> | Transaction<Database>,
  scope: { tenantId: string; logId: string },
  events: readonly StoredEvent[],
  now = Date.now(),
): Promise<void> {
  if (events.length === 0) return;
  const rows = JSON.stringify(events.map(event => [event.entityId, event.entityVersion, event.version]));
  await sql`
    INSERT INTO entity_versions (tenant_id, log_id, entity_id, current_version, log_version, updated_at)
    SELECT ${scope.tenantId}, ${scope.logId}, value ->> 0, value ->> 1, value ->> 2, ${now} FROM json_each(${rows}) WHERE true
    ON CONFLICT (tenant_id, log_id, entity_id) DO UPDATE SET
      current_version = max(current_version, excluded.current_version),
      log_version = max(log_version, excluded.log_version),
      updated_at = excluded.updated_at
  `.execute(executor);
}

/**
 * Tracks entity versions in the local SQLite database
 */
export class EntityVersionTracker {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Gets the current version for an entity
   * 
   * @param entityId - The entity identifier
   * @returns The current entity version, or null if the entity doesn't exist locally
   */
  async getCurrentVersion(entityId: string): Promise<number | null> {
    const context = await requireActiveContext();
    const result = await this.db
      .selectFrom('entity_versions')
      .select('current_version')
      .where('tenant_id', '=', context.tenantId)
      .where('log_id', '=', context.logId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();

    return result?.current_version ?? null;
  }

  /**
   * Updates the entity version after a successful append
   * 
   * @param entityId - The entity identifier
   * @param entityVersion - The new entity version
   * @param logVersion - The log version where this entity version was recorded
   */
  async updateVersion(
    entityId: string,
    entityVersion: number,
    logVersion: number
  ): Promise<void> {
    console.log('[VersionTracker] Updating version for entity', entityId, 'to', entityVersion);
    
    try {
      const now = Date.now();
      const context = await requireActiveContext();

      await this.db
        .insertInto('entity_versions')
        .values({
          tenant_id: context.tenantId,
          log_id: context.logId,
          entity_id: entityId,
          current_version: entityVersion,
          log_version: logVersion,
          updated_at: now
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'log_id', 'entity_id']).doUpdateSet({
            current_version: entityVersion,
            log_version: logVersion,
            updated_at: now
          })
        )
        .execute();
      
      console.log('[VersionTracker] Version updated successfully');
    } catch (error) {
      console.error('[VersionTracker] Failed to update version for entity', entityId, ':', error);
      throw error;
    }
  }

  /**
   * Batch updates entity versions from incoming events
   * 
   * @param events - Array of stored events to process
   */
  async updateVersionsFromEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) {
      console.log('[VersionTracker] No events to update versions from');
      return;
    }

    console.log('[VersionTracker] Updating versions from', events.length, 'events');
    const now = Date.now();
    const context = await requireActiveContext();

    try {
      await this.db.transaction().execute((trx) => writeEntityVersions(trx, context, events, now));
      
      console.log('[VersionTracker] Version updates completed successfully');
    } catch (error) {
      console.error('[VersionTracker] Failed to update versions from events:', error);
      if (error instanceof Error) {
        console.error('[VersionTracker] Error message:', error.message);
        console.error('[VersionTracker] Error stack:', error.stack);
      }
      throw error;
    }
  }

  /**
   * Rebuilds the entity version cache from raw_events table
   * 
   * This is useful for recovering from cache corruption or initializing
   * the cache after a database migration.
   */
  async rebuildVersionCache(): Promise<void> {
    console.log('[VersionTracker] Rebuilding version cache from raw_events');
    
    try {
      // Clear existing cache
      const context = await requireActiveContext();
      await this.db.deleteFrom('entity_versions')
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .execute();
      console.log('[VersionTracker] Cleared existing version cache');

      await rebuildCheckpointVersions(this.db, context);
    } catch (error) {
      console.error('[VersionTracker] Failed to rebuild version cache:', error);
      if (error instanceof Error) {
        console.error('[VersionTracker] Error message:', error.message);
        console.error('[VersionTracker] Error stack:', error.stack);
      }
      throw error;
    }
  }

  /**
   * Gets all entity versions (useful for debugging)
   * 
   * @returns Map of entity IDs to their current versions
   */
  async getAllVersions(): Promise<Map<string, number>> {
    const context = await requireActiveContext();
    const results = await this.db
      .selectFrom('entity_versions')
      .select(['entity_id', 'current_version'])
      .where('tenant_id', '=', context.tenantId)
      .where('log_id', '=', context.logId)
      .execute();

    return new Map(results.map((r) => [r.entity_id, r.current_version]));
  }

  /**
   * Clears all entity version data (useful for testing)
   */
  async clear(): Promise<void> {
    const context = await requireActiveContext();
    await this.db.deleteFrom('entity_versions')
      .where('tenant_id', '=', context.tenantId)
      .where('log_id', '=', context.logId)
      .execute();
  }
}
