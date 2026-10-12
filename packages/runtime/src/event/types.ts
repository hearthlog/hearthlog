/**
 * Event Types
 * 
 * Re-exports all types from the generated file.
 * 
 * IMPORTANT: Do not manually edit event types here.
 * Instead, update entity-definitions.ts and run `pnpm generate:entities`.
 */

// Re-export all generated types
export * from '#generated/types';

// Re-export meta-entity types (runtime entity type management)
export * from './meta-entity-types.js';

// Extended AppEvent union that includes meta-entity events
import type { AppEvent as GeneratedAppEvent } from '#generated/types';
import type { MetaEntityEvent } from './meta-entity-types.js';

export type ExtendedAppEvent = GeneratedAppEvent | MetaEntityEvent;
