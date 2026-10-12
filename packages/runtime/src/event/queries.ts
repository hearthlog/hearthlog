/**
 * Event Queries
 * 
 * Functions for reading events from the local database.
 */

import { db as readModelDB, requireActiveContext } from '../db/index.js';
import type { AppEvent } from './types.js';
import { withTimeout } from '../utils/async.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { sql, type RawBuilder } from 'kysely';

/**
 * Tenant feature visibility as a SQL predicate, so raw event reads never
 * fetch rows they must discard. Mirrors `isVisibleEventType` exactly.
 */
export function visibleEventCondition(): RawBuilder<boolean> {
    const prefixes = [...tenant.approvedEntities.eventPrefixes];
    const prefixCondition = prefixes.length
        ? sql.join(
            prefixes.map((prefix) => sql`type LIKE ${`${prefix}%`}`),
            sql` OR `,
        )
        : sql`0`;
    const dynamicSuffix = tenant.dynamicEntities
        ? sql`(type LIKE '%_ADDED' OR type LIKE '%_UPDATED' OR type LIKE '%_REMOVED')`
        : sql`0`;
    return sql<boolean>`(
        CASE
            WHEN type IN ('EVENT_TOMBSTONED', 'WORKSPACE_RESTORED', 'EVENTS_EXCISED') THEN 1
            WHEN type LIKE 'ENTITY_TYPE_%' THEN ${tenant.dynamicEntities ? 1 : 0}
            WHEN ${prefixCondition} THEN 1
            WHEN ${dynamicSuffix} THEN 1
            ELSE 0
        END = 1
    )`;
}

function parseEventPayload(payload: string): AppEvent['payload'] {
    try {
        return JSON.parse(payload) as AppEvent['payload'];
    } catch (error) {
        throw new Error(
            `Stored event payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Gets all events from the local database (for display purposes)
 */
export async function getAllEvents(order: 'asc' | 'desc' = 'desc'): Promise<AppEvent[]> {
    const context = await requireActiveContext();
    const rows = await readModelDB
        .selectFrom('raw_events')
        .select(['id', 'type', 'timestamp', 'payload'])
        .where('tenant_id', '=', context.tenantId)
        .where('log_id', '=', context.logId)
        .where(visibleEventCondition())
        .orderBy('timestamp', order)
        .execute();

    return rows.map((r) => ({
        id: r.id,
        type: r.type as AppEvent['type'],
        timestamp: r.timestamp,
        payload: parseEventPayload(r.payload),
    }) as AppEvent);
}

/**
 * Gets only local events that haven't been uploaded to the server yet
 */
export async function getEvents(): Promise<AppEvent[]> {
    const context = await requireActiveContext();
    const rows = await withTimeout(
        readModelDB
            .selectFrom('raw_events')
            .select(['id', 'type', 'timestamp', 'payload'])
            .where('tenant_id', '=', context.tenantId)
            .where('log_id', '=', context.logId)
            .where('sync_state', '=', 'pending')
            .where('projection_state', '=', 'effective')
            .where(visibleEventCondition())
            .orderBy('local_sequence', 'asc')
            .execute(),
        5000,
        'getEvents query timed out'
    );

    const localEvents: AppEvent[] = rows.map((r) => ({
        id: r.id,
        type: r.type as AppEvent['type'],
        timestamp: r.timestamp,
        payload: parseEventPayload(r.payload),
    }) as AppEvent);

    console.log(
        `[Event] getEvents returning ${localEvents.length} local-only events`
    );
    return localEvents;
}

/**
 * Keep operational event views within the tenant's feature contract. Raw
 * events remain locally stored for sync/recovery, but disabled feature events
 * must not become a backdoor into another tenant artifact's data model.
 */
export function isVisibleEventType(type: string): boolean {
    if (type === 'EVENT_TOMBSTONED' || type === 'WORKSPACE_RESTORED' || type === 'EVENTS_EXCISED') return true;
    if (type.startsWith('ENTITY_TYPE_')) return tenant.dynamicEntities;
    if ([...tenant.approvedEntities.eventPrefixes].some((prefix) => type.startsWith(prefix))) {
        return true;
    }
    // Dynamic entity events are runtime-defined and are only valid for sites
    // that expose the dynamic entity capability.
    return tenant.dynamicEntities && /_(ADDED|UPDATED|REMOVED)$/.test(type);
}

/**
 * Exports all events as JSON string
 */
export async function exportEventsAsJson(): Promise<string> {
    const allEvents = await getAllEvents('asc');
    return JSON.stringify(allEvents, null, 2);
}
