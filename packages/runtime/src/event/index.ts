/**
 * Event Module
 * 
 * Main entry point for the event sourcing system.
 * Re-exports all public APIs from focused modules.
 */

// Types
export * from './types.js';

// Type Guards
export {
  isTombstoneEvent,
} from './handlers.js';

// Event Handlers
export {
  handleIncomingStoredEvents,
  replaceAllStoredEvents,
  clearActiveProjections,
} from './handlers.js';

// Queries
export {
  getAllEvents,
  getEvents,
  exportEventsAsJson,
} from './queries.js';

// Rebuild
export { rebuildIfSchemaChanged, rebuildReadModel } from './rebuild.js';

// Entity Definitions (single source of truth for adding new entities)
export { ENTITY_DEFINITIONS, getEntityDefinition, getAllEntityNames } from '@hearthlog/contracts/event/entity-definitions';
export type {
  EntityDefinition,
  EntityFieldDefinition,
  EntityIndexDefinition,
  FieldType,
} from '@hearthlog/contracts/event/entity-definitions';

// Entity Registry (auto-generated from definitions)
export { entityRegistry, getAllEntityConfigs, getAllEntityTables } from './registry.js';

// Projection Builder (for advanced use cases)
export type { EntityProjectionConfig, FieldConfig } from './projection-builder.js';
export {
  buildSingleEntityProjectionSQL,
  buildBulkProjectionSQL,
  createEntityProjector,
  PROJECTION_CONFIGS,
  createProjectionConfigFromDefinition,
} from './projection-builder.js';
