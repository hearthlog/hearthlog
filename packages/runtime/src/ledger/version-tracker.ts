/**
 * Entity Version Tracker
 * 
 * Tracks entity versions in the local read model to support optimistic locking.
 * Maintains a cache of current entity versions for fast lookups during event appends.
 */

import type { Kysely } from 'kysely';
import { requireActiveContext, type Database } from '../db/index.js';
import type { StoredEvent } from './types.js';

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
      // Six columns x 100 events remain below the conservative 999-bind limit.
      // SQLite resolves repeated entities and older notifications monotonically.
      await this.db.transaction().execute(async (trx) => {
        for (let offset = 0; offset < events.length; offset += 100) {
          await trx
            .insertInto('entity_versions')
            .values(events.slice(offset, offset + 100).map(event => ({
              tenant_id: context.tenantId,
              log_id: context.logId,
              entity_id: event.entityId,
              current_version: event.entityVersion,
              log_version: event.version,
              updated_at: now
            })))
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'log_id', 'entity_id']).doUpdateSet(eb => ({
                current_version: eb.fn('max', ['current_version', eb.ref('excluded.current_version')]),
                log_version: eb.fn('max', ['log_version', eb.ref('excluded.log_version')]),
                updated_at: now
              }))
            )
            .execute();
        }
      });
      
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

      // Query all events with entity information, ordered by entity and version
      const events = await this.db
        .selectFrom('raw_events')
        .select(['entity_id', 'entity_version', 'log_version', 'timestamp'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where('sync_state', '=', 'synced')
        .where('entity_id', 'is not', null)
        .where('entity_version', 'is not', null)
        .where('log_version', 'is not', null)
        .orderBy('entity_id', 'asc')
        .orderBy('entity_version', 'asc')
        .execute();

      console.log('[VersionTracker] Found', events.length, 'events with entity version data');

      if (events.length === 0) {
        console.log('[VersionTracker] No events to rebuild from');
        return;
      }

      // Group by entity and find the maximum version for each
      const entityVersions = new Map<
        string,
        { currentVersion: number; logVersion: number; updatedAt: number }
      >();

      for (const event of events) {
        if (event.entity_id && event.entity_version !== null) {
          const existing = entityVersions.get(event.entity_id);
          if (event.log_version === null) {
            continue;
          }

          if (!existing || event.entity_version > existing.currentVersion) {
            entityVersions.set(event.entity_id, {
              currentVersion: event.entity_version,
              logVersion: event.log_version,
              updatedAt: event.timestamp
            });
          }
        }
      }

      console.log('[VersionTracker] Rebuilding cache for', entityVersions.size, 'entities');

      // Insert all entity versions in a transaction
      if (entityVersions.size > 0) {
        await this.db.transaction().execute(async (trx) => {
          const values = Array.from(entityVersions.entries()).map(
            ([entityId, { currentVersion, logVersion, updatedAt }]) => ({
              tenant_id: context.tenantId,
              log_id: context.logId,
              entity_id: entityId,
              current_version: currentVersion,
              log_version: logVersion,
              updated_at: updatedAt
            })
          );

          // Insert in batches to avoid hitting SQLite limits
          const batchSize = 100;
          for (let i = 0; i < values.length; i += batchSize) {
            const batch = values.slice(i, i + batchSize);
            await trx.insertInto('entity_versions').values(batch).execute();
            console.log('[VersionTracker] Inserted batch of', batch.length, 'entity versions');
          }
        });
        
        console.log('[VersionTracker] Version cache rebuild completed successfully');
      }
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
