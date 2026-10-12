# 🚀 Performance Improvement Implementation Plan

**Generated:** 2025-01-06  
**Codebase:** SvelteKit Event Sourcing Application  
**Total Estimated Time:** 17-25 hours

---

## 📋 Overview

This plan addresses **21 performance issues** across 5 categories, ordered by impact and dependencies. Each task includes:
- **Files to modify** with exact line numbers
- **Before/After code examples**
- **Dependencies** on other tasks
- **Estimated effort**
- **Testing strategy**
- **Risk assessment**

---

## 🎯 Priority Summary

| Phase | Tasks | Est. Time | Impact | Risk |
|-------|-------|-----------|--------|------|
| **1** | Event Sourcing Fixes | 8-12h | 🔴 Critical | Medium |
| **2** | Database Indexes | 1-2h | 🟠 High | Low |
| **3** | Svelte Components | 3-4h | 🟠 High | Low |
| **4** | Network/Init | 3-4h | 🟡 Medium | Low |
| **5** | Bundle/Build | 2-3h | 🟢 Lower | Very Low |

---

## Phase 1: Critical Event Sourcing Fixes (O(N²) → O(N))

**Total Estimated Time: 8-12 hours**
**Impact: Critical - Eliminates exponential performance degradation**

---

### Task 1.1: Remove `rebuildReadModel()` from Layout Effect

**Priority:** 🔴 Critical  
**Effort:** 30 minutes  
**Risk:** Low  
**Dependencies:** None

#### Problem
Every page load/refresh triggers a full rebuild of all entity tables from raw events.

#### Files to Modify
- `src/routes/+layout.svelte` (lines 49-74)

#### Before
```typescript
$effect(() => {
    let mounted = true;

    async function init() {
        try {
            console.log("[Layout] Starting initialization");

            await rebuildReadModel();  // ← DELETES and rebuilds EVERYTHING
            await refreshLogs();
            // ...
```

#### After
```typescript
$effect(() => {
    let mounted = true;

    async function init() {
        try {
            console.log("[Layout] Starting initialization");

            // Remove rebuildReadModel() - read model is persistent
            // Only sync() is needed for incremental updates
            await refreshLogs();
            // ...
```

#### Testing
1. Load the app → Verify data persists across refreshes
2. Add a transaction → Refresh page → Verify transaction still visible
3. Clear IndexedDB manually → Refresh → Verify sync downloads and projects correctly

---

### Task 1.2: Add Schema Versioning for Conditional Rebuilds

**Priority:** 🔴 Critical  
**Effort:** 1.5 hours  
**Risk:** Low  
**Dependencies:** Task 1.1

#### Problem
Need a mechanism to rebuild only when the schema changes (new entity types, field changes).

#### Files to Create/Modify
- `src/lib/db/kv.ts` (add constants)
- `src/lib/event/rebuild.ts` (add version check)
- `src/routes/+layout.svelte` (use conditional rebuild)

#### Implementation

**1. Add schema version constant** (`src/lib/db/schema.generated.ts` or new file):
```typescript
// Add at top of file or in a new src/lib/db/schema-version.ts
export const SCHEMA_VERSION = 3;  // Increment when entity definitions change
```

**2. Add conditional rebuild function** (`src/lib/event/rebuild.ts`):
```typescript
import { get as getKv, set as setKv } from '$lib/db/kv';
import { SCHEMA_VERSION } from '$lib/db/schema-version';

const SCHEMA_VERSION_KEY = 'schema-version';

/**
 * Rebuilds the read model only if the schema version has changed.
 * Returns true if a rebuild was performed.
 */
export async function rebuildIfSchemaChanged(): Promise<boolean> {
    const storedVersion = await getKv<number>(SCHEMA_VERSION_KEY);
    
    if (storedVersion === SCHEMA_VERSION) {
        console.log('[Event] Schema version unchanged, skipping rebuild');
        return false;
    }
    
    console.log(`[Event] Schema version changed (${storedVersion} → ${SCHEMA_VERSION}), rebuilding...`);
    await rebuildReadModel();
    await setKv(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
    return true;
}
```

**3. Update layout** (`src/routes/+layout.svelte`):
```typescript
import { rebuildIfSchemaChanged } from '$lib/event';

async function init() {
    try {
        console.log("[Layout] Starting initialization");
        
        // Only rebuild if schema changed (e.g., new entity type added)
        await rebuildIfSchemaChanged();
        
        await refreshLogs();
        // ...
```

#### Testing
1. Fresh install → Verify rebuild happens (version 0 → current)
2. Refresh → Verify NO rebuild (version matches)
3. Increment SCHEMA_VERSION → Refresh → Verify rebuild happens

---

### Task 1.3: Batch Projections by Entity in `handleIncomingStoredEvents`

**Priority:** 🔴 Critical  
**Effort:** 2-3 hours  
**Risk:** Medium (core sync logic)  
**Dependencies:** None

#### Problem
Currently projects each event individually, causing N projections for N events of the same entity.

#### Files to Modify
- `src/lib/event/handlers.ts` (lines 328-448)

#### Before (Simplified)
```typescript
export async function handleIncomingStoredEvents(storedEvents: StoredEvent[]): Promise<void> {
    // ...
    await readModelDB.transaction().execute(async (tx) => {
        // 1. Process new events
        for (const storedEvent of newEvents) {
            await tx.insertInto('raw_events').values({...}).execute();
            await projectEventToSqlite(appEvent, tx, storedEvent.entityId);  // ← N projections!
        }
        
        // 2. Process existing events  
        for (const storedEvent of existingEvents) {
            await tx.updateTable('raw_events')...
            await projectEventToSqlite(appEvent, tx, storedEvent.entityId);  // ← More projections!
        }
    });
}
```

#### After
```typescript
export async function handleIncomingStoredEvents(storedEvents: StoredEvent[]): Promise<void> {
    // ...
    
    // Group events by entity to batch projections
    const allEntityIds = new Set<string>();
    
    await readModelDB.transaction().execute(async (tx) => {
        // 1. Insert ALL new events first (batch insert)
        for (const storedEvent of newEvents) {
            const payloadJson = JSON.stringify(storedEvent.payload);
            await tx
                .insertInto('raw_events')
                .values({
                    id: storedEvent.id,
                    type: storedEvent.type,
                    timestamp: storedEvent.timestamp,
                    payload: payloadJson,
                    entity_id: storedEvent.entityId,
                    entity_version: storedEvent.entityVersion,
                })
                .execute();
            
            allEntityIds.add(storedEvent.entityId);
        }
        
        // 2. Update existing events metadata
        for (const storedEvent of existingEvents) {
            await tx
                .updateTable('raw_events')
                .set({
                    entity_id: storedEvent.entityId,
                    entity_version: storedEvent.entityVersion
                })
                .where('id', '=', storedEvent.id)
                .where('entity_version', 'is', null)
                .execute();
            
            allEntityIds.add(storedEvent.entityId);
        }
        
        // 3. Project each entity ONCE (not per-event)
        for (const entityId of allEntityIds) {
            await projectEntityById(entityId, tx);
        }
    });
    
    // ...
}

/**
 * Projects a single entity by its full entity ID.
 * Handles tombstones and finds the correct projector.
 */
async function projectEntityById(
    entityId: string,
    tx: Transaction<Database>
): Promise<void> {
    // Parse entity type from ID (format: "asset:uuid" or "transaction:uuid")
    const [entityType, uuid] = entityId.split(':');
    if (!uuid) {
        console.warn('[Event] Invalid entity ID format:', entityId);
        return;
    }
    
    const entry = entityRegistry[entityType];
    if (!entry) {
        console.warn('[Event] Unknown entity type:', entityType);
        return;
    }
    
    // Delete existing entry
    await tx.deleteFrom(entry.table as keyof Database)
        .where('id', '=', uuid)
        .execute();
    
    // Re-project from events
    const projector = createEntityProjector(entry.projection);
    await projector({ payload: { id: uuid } }, tx, entityId);
}
```

#### Testing
1. Download 100 events for same entity → Verify only 1 projection query runs
2. Check console logs for projection count
3. Verify data integrity after batch sync

---

### Task 1.4: Optimize `processEventBatch` Similarly

**Priority:** 🔴 Critical  
**Effort:** 1.5 hours  
**Risk:** Medium  
**Dependencies:** Task 1.3 (shares helper function)

#### Files to Modify
- `src/lib/event/handlers.ts` (lines 140-204)

#### After
```typescript
async function processEventBatch(
    events: AppEvent[],
    options: { skipRawSave?: boolean } = {}
): Promise<void> {
    if (events.length === 0) return;
    
    events.sort((a, b) => a.timestamp - b.timestamp);
    
    // Group events by entity ID for batch projection
    const eventsByEntity = new Map<string, AppEvent[]>();
    
    try {
        await readModelDB.transaction().execute(async (tx) => {
            // 1. Insert all events to raw_events
            for (const event of events) {
                if (!options.skipRawSave) {
                    const entityId = extractEntityId(event);
                    const payloadJson = JSON.stringify(event.payload);
                    
                    await tx
                        .insertInto('raw_events')
                        .values({
                            id: event.id,
                            type: event.type,
                            timestamp: event.timestamp,
                            payload: payloadJson,
                            entity_id: entityId,
                            entity_version: null,
                        })
                        .onConflict((c) => c.doNothing())
                        .execute();
                    
                    // Group by entity
                    if (!eventsByEntity.has(entityId)) {
                        eventsByEntity.set(entityId, []);
                    }
                    eventsByEntity.get(entityId)!.push(event);
                }
            }
            
            // 2. Handle tombstones first (they affect other projections)
            const tombstones = events.filter(isTombstoneEvent);
            for (const tombstone of tombstones) {
                await handleTombstoneProjection(tombstone, tx);
            }
            
            // 3. Project each entity ONCE
            for (const [entityId, _] of eventsByEntity) {
                // Skip if it was a tombstone-only entity
                const nonTombstoneEvents = eventsByEntity.get(entityId)!
                    .filter(e => !isTombstoneEvent(e));
                
                if (nonTombstoneEvents.length > 0) {
                    await projectEntityById(entityId, tx);
                }
            }
        });
    } catch (error) {
        console.error('[Event] processEventBatch failed:', error);
        throw error;
    }
}
```

---

### Task 1.5: Add `is_tombstoned` Column to Avoid CTE Scans

**Priority:** 🟠 High  
**Effort:** 2-3 hours  
**Risk:** Medium (schema migration)  
**Dependencies:** Tasks 1.1-1.4

#### Problem
Every projection query scans the entire `raw_events` table to find tombstones:
```sql
WITH tombstoned AS (
    SELECT json_extract(payload, '$.eventId') AS tomb_id
    FROM raw_events
    WHERE type = 'EVENT_TOMBSTONED'
)
```

#### Solution
Add a boolean column and update it when tombstones are created.

#### Files to Modify
- `src/lib/db/index.ts` (DDL)
- `src/lib/event/handlers.ts` (update on tombstone)
- `src/lib/event/projection-builder.ts` (simpler CTE)

#### Implementation

**1. Update DDL** (`src/lib/db/index.ts`):
```typescript
const rawEventsDDL = sql`
    CREATE TABLE IF NOT EXISTS "raw_events" (
        "id" TEXT PRIMARY KEY,
        "type" TEXT NOT NULL,
        "timestamp" INTEGER NOT NULL,
        "payload" TEXT NOT NULL,
        "entity_id" TEXT,
        "entity_version" INTEGER,
        "is_tombstoned" INTEGER DEFAULT 0,  -- NEW
        "created_at" TEXT DEFAULT (datetime('now'))
    );
`;

// Add migration for existing databases
const addTombstonedColumn = sql`
    ALTER TABLE "raw_events" ADD COLUMN "is_tombstoned" INTEGER DEFAULT 0;
`;
```

**2. Update tombstone handler** (`src/lib/event/handlers.ts`):
```typescript
async function handleTombstoneProjection(
    event: TombstoneEvent,
    tx: Transaction<Database>
): Promise<void> {
    const targetEventId = event.payload.eventId;
    
    // Mark the target event as tombstoned
    await tx
        .updateTable('raw_events')
        .set({ is_tombstoned: 1 })
        .where('id', '=', targetEventId)
        .execute();
    
    // ... rest of existing logic
}
```

**3. Simplify CTE** (`src/lib/event/projection-builder.ts`):
```typescript
function buildCommonCTEs(): string {
    return `
        WITH effective AS (
            SELECT *
            FROM raw_events
            WHERE is_tombstoned = 0
        )`;
}
```

#### Testing
1. Create a tombstone → Verify `is_tombstoned = 1` on target
2. Run projection → Verify tombstoned events excluded
3. Check query plan → Verify no full table scan for tombstones

---

## Phase 2: Database Query Optimization

**Total Estimated Time: 1-2 hours**
**Impact: High - Faster queries for all list views**

---

### Task 2.1-2.3: Add Entity Table Indexes

**Priority:** 🟠 High  
**Effort:** 30 minutes  
**Risk:** Very Low  
**Dependencies:** None

#### Files to Modify
- `src/lib/db/index.ts` (lines 147-158)

#### Before
```typescript
return [
    ...entityDDLs,
    rawEventsDDL,
    rawEventsTimestampIdx,
    // ... existing indexes
];
```

#### After
```typescript
// Add after existing index definitions (around line 128)

// Entity table indexes for common queries
const transactionsDueDateIdx = sql`
    CREATE INDEX IF NOT EXISTS "idx_transactions_due_date"
    ON "transactions" ("due_date");
`;

const transactionsStatusIdx = sql`
    CREATE INDEX IF NOT EXISTS "idx_transactions_status"
    ON "transactions" ("transaction_status");
`;

const assetsTypeIdx = sql`
    CREATE INDEX IF NOT EXISTS "idx_assets_type"
    ON "assets" ("asset_type");
`;

const invoicesIssueDateIdx = sql`
    CREATE INDEX IF NOT EXISTS "idx_invoices_issue_date"
    ON "invoices" ("issue_date");
`;

const invoicesStatusIdx = sql`
    CREATE INDEX IF NOT EXISTS "idx_invoices_status"
    ON "invoices" ("status");
`;

return [
    ...entityDDLs,
    rawEventsDDL,
    rawEventsTimestampIdx,
    rawEventsTypeIdx,
    rawEventsEntityIdx,
    rawEventsTypeTsIdx,
    rawEventsEntityVersionIdx,
    entityVersionsDDL,
    outboxEventsDDL,
    outboxEventsStatusIdx,
    // NEW indexes:
    transactionsDueDateIdx,
    transactionsStatusIdx,
    assetsTypeIdx,
    invoicesIssueDateIdx,
    invoicesStatusIdx,
];
```

#### Testing
1. Run `EXPLAIN QUERY PLAN` on transaction queries
2. Verify index usage in query plans
3. Benchmark query time before/after

---

## Phase 3: Svelte Component Performance

**Total Estimated Time: 3-4 hours**
**Impact: Medium-High - Smoother UI interactions**

---

### Task 3.1: Add Keys to All `{#each}` Blocks

**Priority:** 🟠 High  
**Effort:** 30 minutes  
**Risk:** Very Low  
**Dependencies:** None

#### Files to Modify

**1. `src/lib/components/finance/TransactionList.svelte` (line 95):**
```svelte
<!-- Before -->
{#each sorted as transaction}
    <TransactionItem {transaction} />
{/each}

<!-- After -->
{#each sorted as transaction (transaction.id)}
    <TransactionItem {transaction} />
{/each}
```

**2. `src/lib/components/finance/TransactionView.svelte` (line 54):**
```svelte
<!-- Before -->
{#each daysInMonth as day, i}
    {@const dayString = format(day, 'yyyy-MM-dd')}
    <TransactionList ... />
{/each}

<!-- After -->
{#each daysInMonth as day (day.toISOString())}
    {@const dayString = format(day, 'yyyy-MM-dd')}
    {@const i = daysInMonth.indexOf(day)}
    <TransactionList ... />
{/each}
```

**3. `src/routes/finance/[year]/[month]/+page.svelte` (line 141):**
```svelte
<!-- Before -->
{#each tabs as tab}

<!-- After -->
{#each tabs as tab (tab.id)}
```

**4. `src/routes/developer/EventLogManager.svelte` (line 184):**
```svelte
<!-- Before -->
{#each files as log}

<!-- After -->
{#each files as log (log.id)}
```

**5. `src/lib/components/layout/NavBar.svelte` (lines 73, 143):**
```svelte
<!-- Add id to navLinks array or use href as key -->
{#each navLinks.filter((l) => !l.mobileOnly) as link (link.href)}
```

---

### Task 3.2: Optimize `groupTransactionsByDay`

**Priority:** 🟡 Medium  
**Effort:** 45 minutes  
**Risk:** Low  
**Dependencies:** None

#### Files to Modify
- `src/lib/components/finance/TransactionView.svelte` (lines 29-47)

#### Before
```typescript
function groupTransactionsByDay(transactions: Transaction[]): Map<string, Transaction[]> {
    const groups = new Map<string, Transaction[]>();
    for (const transaction of transactions) {
        if (!transaction.due_date) continue;
        const date = parseISO(transaction.due_date);  // ← Expensive
        if (isNaN(date.getTime())) continue;
        const day = format(date, 'yyyy-MM-dd');       // ← Expensive
        // ...
    }
}
```

#### After
```typescript
function groupTransactionsByDay(transactions: Transaction[]): Map<string, Transaction[]> {
    const groups = new Map<string, Transaction[]>();
    for (const transaction of transactions) {
        if (!transaction.due_date) continue;
        
        // due_date is already in 'yyyy-MM-dd' format from the database
        // No need to parse and re-format!
        const day = transaction.due_date.slice(0, 10);  // Just take first 10 chars
        
        if (!groups.has(day)) {
            groups.set(day, []);
        }
        groups.get(day)!.push(transaction);
    }
    return groups;
}
```

---

### Task 3.3: Refactor BalanceChart to Only Update Series Data

**Priority:** 🟡 Medium  
**Effort:** 1 hour  
**Risk:** Low  
**Dependencies:** None

#### Files to Modify
- `src/lib/components/finance/BalanceChart.svelte`
- `src/lib/components/finance/BaseStockChart.svelte`

#### Before (`BalanceChart.svelte`)
```typescript
let options: Highcharts.Options = $derived({
    // 60+ lines of config recreated on every change
});
```

#### After (`BalanceChart.svelte`)
```svelte
<script lang="ts">
    // ... imports ...
    
    let { forecastData, startDate, endDate } = $props();
    
    // Static config (never changes)
    const baseOptions: Highcharts.Options = {
        title: { text: '' },
        navigator: { enabled: false },
        scrollbar: { enabled: false },
        rangeSelector: { enabled: false },
        xAxis: {
            type: 'datetime',
            labels: { style: { fontFamily: chartFontFamily } }
        },
        yAxis: {
            title: { text: '' },
            labels: { style: { fontFamily: chartFontFamily } }
        },
        chart: {
            height: null,
            style: { fontFamily: chartFontFamily },
            events: { click: handleChartClick }
        },
        tooltip: { style: { fontFamily: chartFontFamily } },
        series: [{
            type: 'line',
            name: 'balance',
            data: [],  // Will be updated dynamically
            color: '#CCB7C0',
            animation: false,
            events: { click: handleSeriesPointClick }
        }]
    };
    
    // Derived data only (lightweight)
    let seriesData = $derived(
        forecastData.map(({ date, amount }) => [Date.parse(date), amount])
    );
    
    let plotBand = $derived({
        from: startDate.getTime(),
        to: endDate.getTime(),
        color: 'rgba(247, 243, 245, 1)',
    });
    
    let chartRef: Highcharts.Chart | null = null;
</script>

<BaseStockChart 
    options={baseOptions} 
    bind:chart={chartRef}
    {seriesData}
    {plotBand}
/>
```

#### After (`BaseStockChart.svelte`)
```svelte
<script lang="ts">
    // ... existing props ...
    let {
        options,
        seriesData = $bindable<[number, number][]>([]),
        plotBand = $bindable<{ from: number; to: number; color: string } | null>(null),
        chart = $bindable<Highcharts.Chart | null>(null)
    }: BaseStockChartProps = $props();
    
    onMount(() => {
        if (!chartContainer || !options) return;
        chart = highcharts.stockChart(chartContainer, options, callback);
    });
    
    // Update only series data (not full options)
    $effect(() => {
        if (chart && seriesData.length > 0) {
            chart.series[0]?.setData(seriesData, true, false, false);
        }
    });
    
    // Update only plot band
    $effect(() => {
        if (chart && plotBand) {
            const xAxis = chart.xAxis[0];
            // Remove existing band
            xAxis.plotLinesAndBands?.forEach(band => band.destroy());
            // Add new band
            xAxis.addPlotBand({
                from: plotBand.from,
                to: plotBand.to,
                color: plotBand.color,
            });
        }
    });
</script>
```

---

### Task 3.4: Pre-Sort Transactions in Database Query

**Priority:** 🟡 Medium  
**Effort:** 30 minutes  
**Risk:** Very Low  
**Dependencies:** Task 2.1 (index on due_date)

#### Files to Modify
- `src/lib/db/transactions.ts`

#### Before
```typescript
export async function getTransactions(year: number, month: number): Promise<Transaction[]> {
    return await db.selectFrom('transactions')
        .selectAll()
        .where('due_date', '>=', startDate)
        .where('due_date', '<=', endDate)
        .orderBy('due_date', 'asc')  // Already sorted by due_date
        .execute();
}
```

#### After
```typescript
export async function getTransactions(year: number, month: number): Promise<Transaction[]> {
    return await db.selectFrom('transactions')
        .selectAll()
        .where('due_date', '>=', startDate)
        .where('due_date', '<=', endDate)
        .orderBy('due_date', 'asc')
        .orderBy('created_at', 'asc')  // Add secondary sort
        .orderBy('id', 'asc')          // Stable sort tiebreaker
        .execute();
}
```

Then remove the sorting from `TransactionList.svelte`:
```typescript
// Remove this derived
const sorted = $derived.by<Transaction[]>(() => {
    return [...(transactions || [])].sort(compareTx) as Transaction[];
});

// Just use transactions directly
{#each transactions as transaction (transaction.id)}
```

---

## Phase 4: Network & Initialization Optimization

**Total Estimated Time: 3-4 hours**
**Impact: Medium - Faster app startup and sync**

---

### Task 4.1: Parallelize Layout Init Sequence

**Priority:** 🟡 Medium  
**Effort:** 45 minutes  
**Risk:** Low  
**Dependencies:** Task 1.2

#### Files to Modify
- `src/routes/+layout.svelte` (lines 49-72)

#### After
```typescript
async function init() {
    try {
        console.log("[Layout] Starting initialization");
        
        // Phase 1: Schema check + logs refresh can run in parallel
        const [schemaRebuilt, _] = await Promise.all([
            rebuildIfSchemaChanged(),
            refreshLogs(),
        ]);
        
        if (schemaRebuilt) {
            console.log("[Layout] Schema was rebuilt");
        }
        
        // Phase 2: Sync (depends on having logs)
        try {
            await sync();
        } catch (syncError) {
            console.warn("[Layout] Initial sync failed:", syncError);
        }
        
        // Phase 3: realtime socket (fire and forget - don't await)
        startRealtimeConnection().catch(realtimeError => {
            console.warn("[Layout] realtime start failed:", realtimeError);
        });
        
        console.log("[Layout] Initialization complete");
    } catch (error) {
        console.error("[Layout] Initialization failed:", error);
    }
}
```

---

### Task 4.2: Add Request Deduplication to HttpLedgerClient

**Priority:** 🟡 Medium  
**Effort:** 1 hour  
**Risk:** Low  
**Dependencies:** None

#### Files to Modify
- `src/lib/ledger/http-client.ts`

#### Implementation
```typescript
export class HttpLedgerClient {
    private inflightRequests = new Map<string, Promise<unknown>>();
    
    /**
     * Deduplicates concurrent identical GET requests
     */
    private async deduplicatedRequest<T>(
        cacheKey: string,
        requestFn: () => Promise<T>
    ): Promise<T> {
        // Check for inflight request with same key
        const existing = this.inflightRequests.get(cacheKey);
        if (existing) {
            console.log(`[HTTP] Deduplicating request: ${cacheKey}`);
            return existing as Promise<T>;
        }
        
        // Execute and cache the promise
        const promise = requestFn().finally(() => {
            this.inflightRequests.delete(cacheKey);
        });
        
        this.inflightRequests.set(cacheKey, promise);
        return promise;
    }
    
    async listLogs(): Promise<LogSummary[]> {
        return this.deduplicatedRequest('listLogs', async () => {
            const response = await this.request<LogListResponse>({
                method: 'GET',
                path: '/logs',
            });
            return response.logs;
        });
    }
    
    async getLog(logId: string): Promise<LogMetadata> {
        return this.deduplicatedRequest(`getLog:${logId}`, async () => {
            return this.request<LogMetadata>({
                method: 'GET',
                path: `/logs/${logId}`,
            });
        });
    }
    
    // ... apply to other GET methods
}
```

---

### Task 4.3: Implement Optimistic UI Updates in Forms

**Priority:** 🟡 Medium  
**Effort:** 1 hour  
**Risk:** Low  
**Dependencies:** None

#### Files to Modify
- `src/lib/components/finance/AddTransactionForm.svelte`
- `src/lib/components/finance/AddAssetForm.svelte`

#### Before (`AddTransactionForm.svelte`)
```typescript
async function handleAddTransaction() {
    // ...
    try {
        await handleNewEvent(newTransactionEvent);
        signalLocalChange();
        await invalidate('app:transactions');
        
        // Reset form AFTER all DB work
        name = '';
        amount = 0;
```

#### After
```typescript
async function handleAddTransaction() {
    // ...
    
    // Optimistic: Reset form IMMEDIATELY
    const submittedName = name.trim();
    const submittedAmount = amount;
    name = '';
    amount = 0;
    
    try {
        await handleNewEvent(newTransactionEvent);
        signalLocalChange();
        invalidate('app:transactions');  // Don't await - fire and forget
        
        console.log('[Transaction] Transaction created successfully');
    } catch (error) {
        console.error('[Transaction] Failed to create transaction:', error);
        
        // Restore form values on error
        name = submittedName;
        amount = submittedAmount;
        transactionError = `Failed to create transaction: ${error.message}`;
    }
}
```

---

### Task 4.4: Increase Logs Refresh Interval

**Priority:** 🟢 Low  
**Effort:** 15 minutes  
**Risk:** Very Low  
**Dependencies:** None

#### Files to Modify
- `src/routes/+layout.svelte` (line 76)

#### Before
```typescript
logsRefreshInterval = setInterval(async () => {
    // ...
    await refreshLogs();
}, 10000);  // Every 10 seconds
```

#### After
```typescript
logsRefreshInterval = setInterval(async () => {
    // ...
    await refreshLogs();
}, 60000);  // Every 60 seconds (logs rarely change)
```

---

## Phase 5: Bundle & Build Optimization

**Total Estimated Time: 2-3 hours**
**Impact: Medium - Faster initial page load**

---

### Task 5.1: Convert Highcharts to Dynamic Imports

**Priority:** 🟡 Medium  
**Effort:** 1.5 hours  
**Risk:** Low  
**Dependencies:** None

#### Files to Modify
- `src/lib/components/finance/BaseStockChart.svelte`
- `src/lib/components/finance/BalanceChart.svelte`
- `src/lib/components/calc/TaxBreakdownChart.svelte`

#### Before (`BalanceChart.svelte`)
```typescript
import Highcharts from 'highcharts/highstock';  // ← Static import (~300KB)
```

#### After (`BalanceChart.svelte`)
```svelte
<script lang="ts">
    import { onMount } from 'svelte';
    import BaseStockChart from "./BaseStockChart.svelte";
    
    let { forecastData, startDate, endDate } = $props();
    
    let Highcharts: typeof import('highcharts/highstock') | null = $state(null);
    let isLoading = $state(true);
    
    onMount(async () => {
        // Dynamic import - only loads when component mounts
        Highcharts = await import('highcharts/highstock');
        isLoading = false;
    });
    
    // ... rest of component
</script>

{#if isLoading}
    <div class="h-full flex items-center justify-center">
        <span class="text-stone-400">Loading chart...</span>
    </div>
{:else if Highcharts}
    <BaseStockChart {options} highcharts={Highcharts.default} />
{/if}
```

#### After (`BaseStockChart.svelte`)
```svelte
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    
    let {
        options,
        highcharts,  // ← Now passed in (no static import)
        // ...
    } = $props();
    
    // Remove the static import at line 2
    // import * as Highcharts from 'highcharts/highstock';  ← DELETE
```

---

### Task 5.2: Add Vite Compression Plugin

**Priority:** 🟢 Low  
**Effort:** 30 minutes  
**Risk:** Very Low  
**Dependencies:** None

#### Files to Modify
- `package.json` (add dependency)
- `vite.config.ts`

#### Implementation

**1. Install plugin:**
```bash
pnpm add -D vite-plugin-compression
```

**2. Update `vite.config.ts`:**
```typescript
import { sveltekit } from '@sveltejs/kit/vite';
import Icons from 'unplugin-icons/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import viteCompression from 'vite-plugin-compression';  // NEW

export default defineConfig({
    plugins: [
        sveltekit(),
        Icons({ compiler: 'svelte' }),
        // ... existing plugins ...
        
        // NEW: Pre-compress with Brotli
        viteCompression({
            algorithm: 'brotliCompress',
            ext: '.br',
            threshold: 1024,  // Only compress files > 1KB
        }),
        // Also generate gzip for fallback
        viteCompression({
            algorithm: 'gzip',
            ext: '.gz',
            threshold: 1024,
        }),
    ],
    // ...
});
```

---

### Task 5.3: Self-Host Fira Code Font

**Priority:** 🟢 Low  
**Effort:** 45 minutes  
**Risk:** Very Low  
**Dependencies:** None

#### Files to Modify
- `src/app.html`
- `src/app.css`
- `static/fonts/` (new directory)

#### Implementation

**1. Download Fira Code WOFF2 files:**
```bash
mkdir -p static/fonts
# Download from https://github.com/tonsky/FiraCode/releases
# Extract FiraCode-Regular.woff2, FiraCode-Medium.woff2
```

**2. Update `src/app.css`:**
```css
@font-face {
    font-family: 'Fira Code';
    src: url('/fonts/FiraCode-Regular.woff2') format('woff2');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
}

@font-face {
    font-family: 'Fira Code';
    src: url('/fonts/FiraCode-Medium.woff2') format('woff2');
    font-weight: 500;
    font-style: normal;
    font-display: swap;
}
```

**3. Remove Google Fonts from `src/app.html`:**
```html
<!-- DELETE these lines: -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fira+Code&display=swap" rel="stylesheet" />
```

---

### Task 5.4: Optimize PNG Assets

**Priority:** 🟢 Low  
**Effort:** 30 minutes  
**Risk:** Very Low  
**Dependencies:** None

#### Files to Modify
- `static/` (all PNG files)

#### Implementation

**Option A: Convert to WebP (recommended)**
```bash
# Install imagemagick or use online converter
for file in static/*.png; do
    cwebp -q 80 "$file" -o "${file%.png}.webp"
done
```

Update `vite.config.ts` manifest:
```typescript
icons: [
    { src: '/pwa-192x192.webp', sizes: '192x192', type: 'image/webp' },
    { src: '/pwa-512x512.webp', sizes: '512x512', type: 'image/webp' },
]
```

**Option B: Optimize existing PNGs**
```bash
pnpm add -D vite-plugin-imagemin
```

Update `vite.config.ts`:
```typescript
import viteImagemin from 'vite-plugin-imagemin';

plugins: [
    // ...
    viteImagemin({
        pngquant: { quality: [0.8, 0.9] },
    }),
]
```

---

## 🧪 Testing Strategy

### Unit Tests
- Verify `rebuildIfSchemaChanged()` logic
- Test `groupTransactionsByDay()` with edge cases
- Test request deduplication

### Integration Tests
- Sync 100+ events → Verify batch projection
- Refresh page 5 times → Verify no unnecessary rebuilds
- Offline → Add transaction → Online → Verify sync

### Performance Benchmarks
```javascript
// Add to browser console for testing
console.time('sync');
await sync();
console.timeEnd('sync');

console.time('projection');
await handleIncomingStoredEvents(testEvents);
console.timeEnd('projection');
```

---

## 🚦 Rollout Strategy

1. **Phase 1 first** - Biggest impact, enables other optimizations
2. **Phase 2 immediately after** - Indexes help everything
3. **Phases 3-5** - Can be done incrementally, lower risk

---

## 📝 Implementation Checklist

### Phase 1: Event Sourcing Fixes
- [x] 1.1 Remove `rebuildReadModel()` from layout
- [x] 1.2 Add schema versioning
- [x] 1.3 Batch projections in `handleIncomingStoredEvents`
- [x] 1.4 Optimize `processEventBatch`
- [x] 1.5 Add `is_tombstoned` column

### Phase 2: Database Optimization
- [x] 2.1 Add transactions indexes
- [x] 2.2 Add assets indexes
- [x] 2.3 Add invoices indexes

### Phase 3: Svelte Components
- [x] 3.1 Add keys to all `{#each}` blocks
- [x] 3.2 Optimize `groupTransactionsByDay`
- [ ] 3.3 Refactor BalanceChart
- [x] 3.4 Pre-sort transactions in DB

### Phase 4: Network & Init
- [x] 4.1 Parallelize layout init
- [ ] 4.2 Add request deduplication
- [x] 4.3 Implement optimistic UI updates
- [ ] 4.4 Increase logs refresh interval

### Phase 5: Bundle & Build
- [ ] 5.1 Dynamic Highcharts imports
- [ ] 5.2 Add compression plugin
- [ ] 5.3 Self-host fonts
- [ ] 5.4 Optimize assets

---

## 📊 Expected Performance Gains

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Initial Load** | 2-3s | 1-1.5s | 40-50% |
| **Event Processing** | O(N²) | O(N) | 90%+ for large N |
| **Query Time** | 100-500ms | 10-50ms | 80-90% |
| **Bundle Size** | ~1.2MB | ~900KB | 25% |
| **UI Responsiveness** | Janky | Smooth | Significant |

---

## 🔄 Future Considerations

1. **Snapshotting** - For entities with 10k+ events
2. **Virtual Scrolling** - For large transaction lists
3. **Web Workers** - For heavy computations
4. **Service Worker Caching** - For API responses
5. **Database Sharding** - For multi-tenant scaling

---

**Generated by:** Sisyphus (AI Agent)  
**Date:** 2025-01-06  
**Version:** 1.0
