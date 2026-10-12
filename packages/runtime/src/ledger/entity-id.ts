/**
 * Entity ID extraction utilities for mapping AppEvent types to entity identifiers.
 * This module implements the entity ID extraction logic using the entity registry.
 */

import type { ExtendedAppEvent, TombstoneEvent } from '../event/types.js';
import { isMetaEntityEvent } from '../event/types.js';
import { entityRegistry } from '../event/registry.js';

function inferEntityNameFromEventType(type: string): string | null {
  const match = type.match(/^(.*)_(ADDED|UPDATED|REMOVED)$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extracts the entity identifier from an AppEvent.
 * 
 * Entity IDs are prefixed with their type to prevent collisions between different entity types
 * and to make debugging easier with self-documenting IDs.
 * 
 * Uses the entity registry for dynamic dispatch - no changes needed when adding new entities.
 * 
 * Mapping rules:
 * - Entity events: `{entityName}:{payload.id}` (e.g., `asset:123`, `transaction:456`)
 * - Tombstone events: `tombstone:{payload.eventId}`
 * 
 * @param event - The AppEvent to extract the entity ID from
 * @returns The entity identifier string
 * 
 * @example
 * ```typescript
 * const event: AddCalendarEventEvent = {
 *   id: 'evt-123',
 *   type: 'CALENDAR_EVENT_ADDED',
 *   timestamp: Date.now(),
 *   payload: { id: 'event-456', title: 'Dentist', eventDate: '2026-10-12', startTime: '', notes: '', pinned: false }
 * };
 * const entityId = extractEntityId(event); // Returns: 'asset:asset-456'
 * ```
 */
export function extractEntityId(event: ExtendedAppEvent): string {
  // Handle tombstone events specially
  if (event.type === 'EVENT_TOMBSTONED') {
    return `tombstone:${(event as TombstoneEvent).payload.eventId}`;
  }

  // Excision markers are their own entity so they never join an existing
  // entity's version chain.
  if (event.type === 'EVENTS_EXCISED') {
    return `excision:${event.id}`;
  }

  if (isMetaEntityEvent(event)) {
    return `entity_type:${event.payload.id}`;
  }

  // Match the most specific prefix: one entity's prefix can start another's
  // (FOO_ and FOO_BAR_), and definition order must not change event ownership.
  let match: { name: string; prefix: string } | null = null;
  for (const [name, entry] of Object.entries(entityRegistry)) {
    if (event.type.startsWith(entry.eventPrefix) && (!match || entry.eventPrefix.length > match.prefix.length)) {
      match = { name, prefix: entry.eventPrefix };
    }
  }
  if (match) return `${match.name}:${(event.payload as { id: string }).id}`;

  const payloadId = (event.payload as { id?: string }).id;
  const inferredEntityName = inferEntityNameFromEventType(event.type);
  if (payloadId && inferredEntityName) {
    return `${inferredEntityName}:${payloadId}`;
  }

  // Fallback for unknown event types
  return `unknown:${event.id}`;
}

/**
 * Extracts entity IDs from a batch of events.
 * 
 * @param events - Array of AppEvents
 * @returns Array of entity identifier strings in the same order
 */
export function extractEntityIds(events: ExtendedAppEvent[]): string[] {
  return events.map(extractEntityId);
}

/**
 * Groups events by their entity ID.
 * Useful for batch operations that need to process events per entity.
 * 
 * @param events - Array of AppEvents to group
 * @returns Map of entity ID to array of events for that entity
 * 
 * @example
 * ```typescript
 * const events = [assetEvent1, transactionEvent1, assetEvent2];
 * const grouped = groupEventsByEntity(events);
 * // Returns: Map {
 * //   'asset:123' => [assetEvent1, assetEvent2],
 * //   'transaction:456' => [transactionEvent1]
 * // }
 * ```
 */
export function groupEventsByEntity(events: ExtendedAppEvent[]): Map<string, ExtendedAppEvent[]> {
  const grouped = new Map<string, ExtendedAppEvent[]>();

  for (const event of events) {
    const entityId = extractEntityId(event);
    const existing = grouped.get(entityId) || [];
    existing.push(event);
    grouped.set(entityId, existing);
  }

  return grouped;
}
