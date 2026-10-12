# Guide to Adding a New Entity

This guide details the steps to add a new entity (e.g., "Goal") to the application.

## Overview

The architecture uses a **code generation** approach. Adding a new entity requires only:
1. Add entity definition
2. Create UI components

Everything else is **auto-generated**: event types, database schema, DDL, projection configs, registry entries, event handlers, and entity ID extraction.

## Step 1: Add Entity Definition

**File:** `packages/contracts/src/event/entity-definitions.ts`

This is the **single source of truth** for entity configuration. Add your entity to the `ENTITY_DEFINITIONS` array:

```typescript
export const ENTITY_DEFINITIONS: EntityDefinition[] = [
    // ... existing entities ...
    
    {
        name: 'goal',
        table: 'goals',
        fields: [
            { name: 'name', type: 'string', payloadKey: 'name', required: true },
            { name: 'target_amount', type: 'number', payloadKey: 'target_amount', required: true },
            { name: 'progress', type: 'number', payloadKey: 'progress', default: 0 },
        ],
        indexes: [
            {
                name: 'idx_goals_scope_progress',
                columns: ['tenant_id', 'log_id', 'progress'],
            },
        ],
    },
];
```

**Field configuration:**
- `name` - Database column name (snake_case)
- `type` - `'string'`, `'number'`, or `'boolean'`
- `payloadKey` - Event payload key. Usually same as `name` for consistency
- `required` - Whether field is required in ADD events
- `default` - Default value. Use SQL expressions like `"date('now')"` for dynamic defaults

**Index configuration:**
- `name` - Stable, globally unique SQLite index name
- `columns` - Ordered database columns; multiple entries define a composite index
- `unique` - Optional flag for a unique index

Automatic projection columns (`tenant_id`, `log_id`, `id`, `created_at`, and
`updated_at`) can also be referenced. Entity indexes are generated and installed
after schema migration, so scoped indexes are safe for existing databases.

Then run the generator:

```bash
pnpm generate:entities
```

> **Note:** The generator runs automatically on `pnpm dev` and `pnpm build`.

## Step 2: Create UI Components

Create smart components following the established pattern:

**File:** `src/lib/components/GoalItem.svelte`

```svelte
<script lang="ts">
    import { handleNewEvent } from '#lib/event';
    import type { Goal } from '#lib/db/schema.generated.js';
    import { signalLocalChange } from '#lib/store/sync.svelte.js';
    import { invalidate } from '$app/navigation';
    
    let { goal } = $props<{ goal: Goal }>();
    
    async function handleUpdate() {
        await handleNewEvent({
            id: crypto.randomUUID(),
            type: 'GOAL_UPDATED',
            timestamp: Date.now(),
            payload: { id: goal.id, name: editingName }
        });
        signalLocalChange();
        await invalidate('app:goals');
    }
</script>
```

## That's It!

Only **2 files** need to be modified:
1. `entity-definitions.ts` - Add the entity definition
2. UI components - Create Svelte components

## What Gets Auto-Generated

When you run `pnpm generate:entities`, the following files are created:

### `.generated/src/types.generated.ts`
- Event payload interfaces (`AddGoalPayload`, `UpdateGoalPayload`, `RemoveGoalPayload`)
- Event types (`AddGoalEvent`, `UpdateGoalEvent`, `RemoveGoalEvent`)
- Entity event union (`GoalEvent`)
- Updated `AppEvent` union

### `.generated/src/schema.generated.ts`
- Entity type (`Goal`)
- Kysely table type (`GoalTable`)
- DDL string (`GOAL_DDL`)
- Updated `EntityDatabaseTables` interface

### Other files that auto-update at runtime
- `registry.ts` - Entity registry entry
- `projection-builder.ts` - Projection config
- `handlers.ts` - Event dispatch (dynamic)
- `entity-id.ts` - Entity ID extraction (dynamic)

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   entity-definitions.ts                      │
│                  (Single Source of Truth)                    │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
            ┌──────────────────────────────┐
            │   pnpm generate:entities      │
            │   packages/tooling/src/generate/generate-entities.ts│
            └───────────────┬──────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
┌───────────────────────┐           ┌───────────────────────┐
│ types.generated.ts    │           │ schema.generated.ts   │
│ - Event payloads      │           │ - Entity types        │
│ - Event types         │           │ - Table types         │
│ - AppEvent union      │           │ - DDL statements      │
└───────────────────────┘           └───────────────────────┘
        │                                       │
        ▼                                       ▼
┌───────────────────────┐           ┌───────────────────────┐
│      types.ts         │           │     db/index.ts       │
│   (re-exports)        │           │   (re-exports)        │
└───────────────────────┘           └───────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────┐
│   projection-builder  │       │       registry        │
│   (runtime configs)   │◄──────│   (runtime entries)   │
└───────────────────────┘       └───────────────────────┘
                                            │
            ┌───────────────┬───────────────┤
            ▼               ▼               ▼
     ┌──────────┐    ┌───────────┐    ┌──────────┐
     │ handlers │    │ entity-id │    │  rebuild │
     │ (dynamic)│    │ (dynamic) │    │ (dynamic)│
     └──────────┘    └───────────┘    └──────────┘
```

## Summary

**Before automation:** 8 files to modify
**After automation:** 2 files to modify

| What | How |
|------|-----|
| Entity definition | Add object to `ENTITY_DEFINITIONS` |
| Event types | ✨ Auto-generated |
| Database schema | ✨ Auto-generated |
| DDL | ✨ Auto-generated |
| Projection config | ✨ Auto-generated |
| Registry entry | ✨ Auto-generated |
| Event handlers | ✨ Dynamic dispatch |
| Entity ID extraction | ✨ Dynamic lookup |
| UI components | Create manually |
