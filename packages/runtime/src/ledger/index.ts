/**
 * Ledger Service client library
 *
 * This module provides the main exports for interacting with the Ledger Service API.
 */

// Configuration
export {
  loadLedgerConfig,
  type LedgerConfig,
  type RetryPolicy,
  ConfigValidationError,
} from "./config.js";

// Error classes and type guards
export {
  LedgerServiceError,
  VersionConflictError,
  NotFoundError,
  AuthenticationError,
  EntityVersionChainError,
  IdempotencyMismatchError,
  isLedgerServiceError,
  isVersionConflictError,
  isNotFoundError,
  isAuthenticationError,
} from "./errors.js";

// Ledger transport
export { LedgerClient } from "./http-client.js";
export { getLedgerClient } from './client.js';
export {
  LedgerAdminClient,
  LedgerAdminError,
  LedgerAdminUnauthorizedError,
  type AdminAppListResponse,
  type AdminAppSummary,
  type AdminAppTokenResponse,
  type AdminErrorResponse,
  type AdminSession,
} from "./admin-client.js";

// Types
export * from "./types.js";

// Entity ID utilities
export {
  extractEntityId,
  extractEntityIds,
  groupEventsByEntity,
} from "./entity-id.js";

// WebSocket realtime delivery
export {
  EventSocket,
  createEventSocket,
  SocketState,
  SocketProtocolError,
  LEDGER_SOCKET_PROTOCOL,
  type EventSocketConfig,
  type SocketFrame,
  type SocketUrlProvider,
  type SocketResyncReason,
} from "./socket.js";

// Version tracking
export { EntityVersionTracker } from "./version-tracker.js";
