/**
 * TypeScript type definitions matching the Event Store Service OpenAPI specification v0.4.0
 * These types represent the API contract between the client and the Ledger Service.
 */

// ============================================================================
// Log Management Types
// ============================================================================

/**
 * Summary information about a log
 */
export interface LogSummary {
  /** Server-generated log identifier */
  id: string;
  /** Human-readable log name */
  name: string;
  /** Timestamp when the log was created. */
  createdAt?: string;
  /** Current highest version in the log */
  headVersion: number;
  /** Timestamp of the most recent update (ISO 8601 format) */
  lastUpdatedAt: string | null;
  /** Provenance for a materialized fork. */
  sourceLogId?: string | null;
  sourceLogName?: string | null;
  sourceVersion?: number | null;
  /** Timestamp of the selected source event when a version exists. */
  sourceTimestamp?: string | null;
  status?: 'ready' | 'preparing';
  /** When the log was hidden from the log tree; missing from older Ledger responses. */
  hiddenAt?: string | null;
}

export interface ForkLogRequest {
  name: string;
  targetVersion: number;
  expectedSourceHeadVersion: number;
  requestId: string;
}

/**
 * Response containing a list of logs
 */
export interface LogListResponse {
  logs: LogSummary[];
  /** Server-ordered fork relationships for the log tree. */
  lineage?: LogLineageIndex;
}

export interface LogLineageIndex {
  rootIds: string[];
  childIdsByLogId: Record<string, string[]>;
}

/**
 * Request to create a new log
 */
export interface CreateLogRequest {
  /** Optional display name for the log */
  name?: string;
}

/**
 * Response after creating a new log
 */
export interface CreateLogResponse {
  /** Newly created log identifier */
  id: string;
  /** Effective log name (may be generated when none provided) */
  name: string;
  /** Initial head version (typically 0 for new logs) */
  headVersion: number;
  /** Timestamp when the log was created (ISO 8601 format) */
  createdAt: string;
}

/**
 * Detailed metadata about a log (same as LogSummary)
 */
export type LogMetadata = LogSummary;

export interface SessionResponse {
  capabilities?: string[];
  appId: string;
  principalId: string;
}

export interface ErrorResponse {
  error: string;
  code: string;
  message?: string | null;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event being sent to the server for appending
 */
export interface IncomingEvent {
  /** Optional event identifier supplied by the client (UUID format) */
  id?: string;
  /** Domain event type (e.g., 'CALENDAR_EVENT_ADDED') */
  type: string;
  /** Identifier of the entity affected by the event */
  entityId: string;
  /**
   * Expected entity version for optimistic locking.
   * Required when appending to an existing entity.
   * Omit only when creating a new entity (first event for that entityId).
   */
  baseEntityVersion?: number;
  /** Optional client timestamp in milliseconds since Unix epoch */
  timestamp?: number;
  /** Event payload to persist as-is */
  payload: Record<string, unknown>;
}

/**
 * Event as stored and returned by the server
 */
export interface StoredEvent {
  /** Complete accepted action; absent for legacy events. */
  action?: { id: string; index: number; size: number };
  /** Monotonic sequence number within the log (global log version) */
  version: number;
  /** Event identifier (typically a UUID) */
  id: string;
  /** Domain event type (e.g., 'CALENDAR_EVENT_ADDED') */
  type: string;
  /** Identifier of the entity associated with the event */
  entityId: string;
  /** Monotonic sequence number specific to this entity (starts at 1) */
  entityVersion: number;
  /** Milliseconds since Unix epoch when the event was committed */
  timestamp: number;
  /** Event-specific data */
  payload: Record<string, unknown>;
  /** Identity the gateway verified when the event was accepted; absent for older events. */
  actor?: string;
}

/**
 * Batch of events returned by query endpoints
 */
export interface EventBatch {
  events: StoredEvent[];
}

/**
 * Event delivered via realtime transport (same shape as StoredEvent)
 */
export type RealtimeEvent = StoredEvent;

// ============================================================================
// Event Append Types
// ============================================================================

/**
 * Request to append events to a log
 */
export interface AppendEventsRequest {
  expectedLogVersion?: number;
  /** Stable identity of a complete user action, when supported by the server. */
  actionId?: string;
  /** Client-generated UUID used for idempotency */
  requestId: string;
  /** Events to append (in desired order) */
  events: IncomingEvent[];
}

/**
 * Response after successfully appending events
 */
export interface AppendEventsResponse {
  /** Version assigned to the last persisted event */
  newVersion: number;
  /** Events actually stored (with server-assigned ids/timestamps/versions) */
  events: StoredEvent[];
}

/**
 * Response when a version conflict occurs (HTTP 409)
 */
export interface ConflictResponse {
  code: "entity_conflict";
  /** The entity identifier that caused the conflict */
  entityId: string;
  /** Current version of the conflicting entity */
  currentEntityVersion: number;
  /** Current head version of the entire log (for context) */
  currentLogVersion: number;
}

export interface EntityVersionChainErrorResponse extends ErrorResponse {
  code: "invalid_entity_version_chain";
  entityId: string;
  expectedBaseEntityVersion: number | null;
  actualBaseEntityVersion: number | null;
}
