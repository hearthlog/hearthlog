import { requireActiveContext, setActiveContext } from '../db/index.js';
import { set as setKv } from '../db/kv.js';
import { handleIncomingStoredEvents, replaceAllStoredEvents } from '../event/index.js';
import type { DynamicFieldDefinition } from '../event/meta-entity-types.js';
import type { StoredEvent } from '../ledger/types.js';
import { notifyEventsChanged } from '../store/events.svelte.js';
import {
    addSyncLogEntry,
    stopRealtime,
} from '../store/sync.svelte.js';

export const PERFORMANCE_DATASET_LOG_ID = 'perf-benchmark-local';

export interface PerformanceDatasetConfig {
    vendorCount: number;
    categoryCount: number;
    itemCount: number;
    updateCount: number;
    replayCount: number;
}

export interface PerformanceDatasetManifest {
    config: PerformanceDatasetConfig;
    entityTypeCount: number;
    dynamicEntityCount: number;
    seedEventCount: number;
    replayEventCount: number;
    seedHeadVersion: number;
    replayHeadVersion: number;
    referenceFieldCount: number;
}

export interface PerformanceDataset {
    manifest: PerformanceDatasetManifest;
    seedEvents: StoredEvent[];
    replayEvents: StoredEvent[];
}

const ENTITY_NAMES = {
    vendor: 'perf_vendor',
    category: 'perf_category',
    item: 'perf_item',
} as const;

export const DEFAULT_PERFORMANCE_DATASET_CONFIG: PerformanceDatasetConfig = {
    vendorCount: 40,
    categoryCount: 120,
    itemCount: 1200,
    updateCount: 320,
    replayCount: 250,
};

function assertPositiveInteger(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
}

function validateConfig(config: PerformanceDatasetConfig): void {
    assertPositiveInteger(config.vendorCount, 'vendorCount');
    assertPositiveInteger(config.categoryCount, 'categoryCount');
    assertPositiveInteger(config.itemCount, 'itemCount');
    assertPositiveInteger(config.updateCount, 'updateCount');
    assertPositiveInteger(config.replayCount, 'replayCount');
}

function padIndex(index: number): string {
    return String(index).padStart(4, '0');
}

function createId(kind: string, index: number): string {
    return `perf-${kind}-${padIndex(index)}`;
}

function createEntityId(entityName: string, id: string): string {
    return `${entityName}:${id}`;
}

function createEntityTypeFields(
    entityName:
        | typeof ENTITY_NAMES.vendor
        | typeof ENTITY_NAMES.category
        | typeof ENTITY_NAMES.item
): DynamicFieldDefinition[] {
    if (entityName === ENTITY_NAMES.vendor) {
        return [
            { name: 'name', type: 'string', payloadKey: 'name', required: true },
            { name: 'tier', type: 'string', payloadKey: 'tier', required: true },
            { name: 'rating', type: 'number', payloadKey: 'rating', required: true },
            { name: 'is_preferred', type: 'boolean', payloadKey: 'isPreferred', default: false },
        ];
    }

    if (entityName === ENTITY_NAMES.category) {
        return [
            { name: 'name', type: 'string', payloadKey: 'name', required: true },
            { name: 'group_code', type: 'string', payloadKey: 'groupCode', required: true },
            { name: 'sort_order', type: 'number', payloadKey: 'sortOrder', required: true },
        ];
    }

    return [
        { name: 'name', type: 'string', payloadKey: 'name', required: true },
        { name: 'sku', type: 'string', payloadKey: 'sku', required: true },
        { name: 'status', type: 'string', payloadKey: 'status', required: true },
        { name: 'amount', type: 'number', payloadKey: 'amount', required: true },
        { name: 'score', type: 'number', payloadKey: 'score', required: true },
        {
            name: 'vendor_id',
            type: 'reference',
            payloadKey: 'vendorId',
            required: true,
            referenceTo: ENTITY_NAMES.vendor,
        },
        {
            name: 'backup_vendor_id',
            type: 'reference',
            payloadKey: 'backupVendorId',
            required: true,
            referenceTo: ENTITY_NAMES.vendor,
        },
        {
            name: 'category_id',
            type: 'reference',
            payloadKey: 'categoryId',
            required: true,
            referenceTo: ENTITY_NAMES.category,
        },
        { name: 'captured_at', type: 'datetime', payloadKey: 'capturedAt', required: true },
        { name: 'is_active', type: 'boolean', payloadKey: 'isActive', default: true },
    ];
}

function buildEntityTypeDefinitionEvents(): Array<{
    entityName: string;
    typeId: string;
    fields: DynamicFieldDefinition[];
}> {
    return [
        {
            entityName: ENTITY_NAMES.vendor,
            typeId: createId('entity-type-vendor', 1),
            fields: createEntityTypeFields(ENTITY_NAMES.vendor),
        },
        {
            entityName: ENTITY_NAMES.category,
            typeId: createId('entity-type-category', 1),
            fields: createEntityTypeFields(ENTITY_NAMES.category),
        },
        {
            entityName: ENTITY_NAMES.item,
            typeId: createId('entity-type-item', 1),
            fields: createEntityTypeFields(ENTITY_NAMES.item),
        },
    ];
}

function pushStoredEvent(
    events: StoredEvent[],
    options: {
        version: number;
        entityVersion: number;
        type: string;
        entityId: string;
        timestamp: number;
        payload: Record<string, unknown>;
    }
): void {
    events.push({
        version: options.version,
        id: `perf-event-${String(options.version).padStart(6, '0')}`,
        type: options.type,
        entityId: options.entityId,
        entityVersion: options.entityVersion,
        timestamp: options.timestamp,
        payload: options.payload,
    });
}

export function buildPerformanceDataset(
    config: PerformanceDatasetConfig = DEFAULT_PERFORMANCE_DATASET_CONFIG
): PerformanceDataset {
    validateConfig(config);

    const seedEvents: StoredEvent[] = [];
    const replayEvents: StoredEvent[] = [];
    const entityVersions = new Map<string, number>();
    const vendorIds = Array.from({ length: config.vendorCount }, (_, index) =>
        createId('vendor', index + 1)
    );
    const categoryIds = Array.from({ length: config.categoryCount }, (_, index) =>
        createId('category', index + 1)
    );
    const itemIds = Array.from({ length: config.itemCount }, (_, index) =>
        createId('item', index + 1)
    );
    const entityTypeDefinitions = buildEntityTypeDefinitionEvents();

    let version = 1;
    const baseTimestamp = Date.UTC(2026, 2, 11, 12, 0, 0);

    for (const [index, definition] of entityTypeDefinitions.entries()) {
        pushStoredEvent(seedEvents, {
            version,
            entityVersion: 1,
            type: 'ENTITY_TYPE_DEFINED',
            entityId: `entity_type:${definition.typeId}`,
            timestamp: baseTimestamp + index,
            payload: {
                id: definition.typeId,
                name: definition.entityName,
                displayName: definition.entityName
                    .split('_')
                    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                    .join(' '),
                tableName: `${definition.entityName}s`,
                fields: definition.fields,
            },
        });
        version += 1;
    }

    for (const [index, vendorId] of vendorIds.entries()) {
        const entityId = createEntityId(ENTITY_NAMES.vendor, vendorId);
        entityVersions.set(entityId, 1);
        pushStoredEvent(seedEvents, {
            version,
            entityVersion: 1,
            type: 'PERF_VENDOR_ADDED',
            entityId,
            timestamp: baseTimestamp + version,
            payload: {
                id: vendorId,
                name: `Vendor ${index + 1}`,
                tier: ['bronze', 'silver', 'gold'][index % 3],
                rating: Number((3.2 + ((index % 15) * 0.1)).toFixed(1)),
                isPreferred: index % 5 === 0,
            },
        });
        version += 1;
    }

    for (const [index, categoryId] of categoryIds.entries()) {
        const entityId = createEntityId(ENTITY_NAMES.category, categoryId);
        entityVersions.set(entityId, 1);
        pushStoredEvent(seedEvents, {
            version,
            entityVersion: 1,
            type: 'PERF_CATEGORY_ADDED',
            entityId,
            timestamp: baseTimestamp + version,
            payload: {
                id: categoryId,
                name: `Category ${index + 1}`,
                groupCode: `G-${String((index % 12) + 1).padStart(2, '0')}`,
                sortOrder: index + 1,
            },
        });
        version += 1;
    }

    for (const [index, itemId] of itemIds.entries()) {
        const entityId = createEntityId(ENTITY_NAMES.item, itemId);
        const vendorId = vendorIds[index % vendorIds.length];
        const backupVendorId =
            vendorIds[(index + 7) % vendorIds.length];
        const categoryId = categoryIds[index % categoryIds.length];

        entityVersions.set(entityId, 1);
        pushStoredEvent(seedEvents, {
            version,
            entityVersion: 1,
            type: 'PERF_ITEM_ADDED',
            entityId,
            timestamp: baseTimestamp + version,
            payload: {
                id: itemId,
                name: `Benchmark Item ${index + 1}`,
                sku: `SKU-${String(index + 1).padStart(5, '0')}`,
                status: ['draft', 'active', 'review'][index % 3],
                amount: 100 + (index % 50) * 17,
                score: Number((50 + (index % 300) * 0.25).toFixed(2)),
                vendorId,
                backupVendorId,
                categoryId,
                capturedAt: new Date(baseTimestamp + index * 60_000).toISOString(),
                isActive: index % 17 !== 0,
            },
        });
        version += 1;
    }

    for (let index = 0; index < config.updateCount; index += 1) {
        const itemId = itemIds[index % itemIds.length];
        const entityId = createEntityId(ENTITY_NAMES.item, itemId);
        const entityVersion = (entityVersions.get(entityId) ?? 1) + 1;
        entityVersions.set(entityId, entityVersion);

        pushStoredEvent(seedEvents, {
            version,
            entityVersion,
            type: 'PERF_ITEM_UPDATED',
            entityId,
            timestamp: baseTimestamp + version,
            payload: {
                id: itemId,
                status: ['active', 'review', 'archived'][index % 3],
                amount: 250 + (index % 60) * 23,
                score: Number((60 + (index % 200) * 0.37).toFixed(2)),
                backupVendorId: vendorIds[(index + 11) % vendorIds.length],
                capturedAt: new Date(baseTimestamp + (index + 10_000) * 30_000).toISOString(),
                isActive: index % 9 !== 0,
            },
        });
        version += 1;
    }

    const seedHeadVersion = version - 1;

    for (let index = 0; index < config.replayCount; index += 1) {
        const itemId = itemIds[(index * 7) % itemIds.length];
        const entityId = createEntityId(ENTITY_NAMES.item, itemId);
        const entityVersion = (entityVersions.get(entityId) ?? 1) + 1;
        entityVersions.set(entityId, entityVersion);

        pushStoredEvent(replayEvents, {
            version,
            entityVersion,
            type: 'PERF_ITEM_UPDATED',
            entityId,
            timestamp: baseTimestamp + version,
            payload: {
                id: itemId,
                status: ['review', 'active', 'archived', 'active'][index % 4],
                amount: 400 + (index % 75) * 19,
                score: Number((80 + (index % 250) * 0.19).toFixed(2)),
                vendorId: vendorIds[(index + 3) % vendorIds.length],
                backupVendorId: vendorIds[(index + 17) % vendorIds.length],
                categoryId: categoryIds[(index + 5) % categoryIds.length],
                capturedAt: new Date(baseTimestamp + (index + 20_000) * 15_000).toISOString(),
                isActive: index % 13 !== 0,
            },
        });
        version += 1;
    }

    const manifest: PerformanceDatasetManifest = {
        config: { ...config },
        entityTypeCount: entityTypeDefinitions.length,
        dynamicEntityCount:
            config.vendorCount + config.categoryCount + config.itemCount,
        seedEventCount: seedEvents.length,
        replayEventCount: replayEvents.length,
        seedHeadVersion,
        replayHeadVersion: version - 1,
        referenceFieldCount: 3,
    };

    return {
        manifest,
        seedEvents,
        replayEvents,
    };
}

export async function loadPerformanceDataset(
    config: PerformanceDatasetConfig = DEFAULT_PERFORMANCE_DATASET_CONFIG
): Promise<PerformanceDatasetManifest> {
    const dataset = buildPerformanceDataset(config);
    await stopRealtime();
    const context = await requireActiveContext();
    // setActiveContext updates this tab's session + last-used defaults
    await setActiveContext({ ...context, logId: PERFORMANCE_DATASET_LOG_ID });
    await replaceAllStoredEvents(dataset.seedEvents);
    await setKv('db-log-id', PERFORMANCE_DATASET_LOG_ID);
    await setKv('log-head-version', dataset.manifest.seedHeadVersion);
    notifyEventsChanged();
    await addSyncLogEntry(
        'download',
        'Loaded local performance benchmark dataset',
        `${dataset.manifest.seedEventCount} stored events`
    );

    return dataset.manifest;
}

export async function replayPerformanceDataset(
    config: PerformanceDatasetConfig = DEFAULT_PERFORMANCE_DATASET_CONFIG
): Promise<PerformanceDatasetManifest> {
    const dataset = buildPerformanceDataset(config);
    await stopRealtime();
    const context = await requireActiveContext();
    await setActiveContext({ ...context, logId: PERFORMANCE_DATASET_LOG_ID });
    await handleIncomingStoredEvents(dataset.replayEvents);
    await setKv('db-log-id', PERFORMANCE_DATASET_LOG_ID);
    await setKv('log-head-version', dataset.manifest.replayHeadVersion);
    notifyEventsChanged();
    await addSyncLogEntry(
        'download',
        'Replayed local performance sync burst',
        `${dataset.manifest.replayEventCount} stored events`
    );

    return dataset.manifest;
}
