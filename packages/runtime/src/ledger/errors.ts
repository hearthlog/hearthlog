/**
 * Ledger Service Error Classes
 *
 * Custom error types for Ledger Service API operations with:
 * - Proper stack trace capture
 * - Type guard functions for safe narrowing
 * - Error cause chaining support
 * - Discriminator tags for reliable instanceof alternatives
 */

import type {
    ConflictResponse,
    EntityVersionChainErrorResponse,
} from "./types.js";

// ============================================================================
// Base Error
// ============================================================================

export interface LedgerErrorOptions {
    cause?: Error;
}

/**
 * Base error class for all Ledger Service API errors
 */
export class LedgerServiceError extends Error {
    readonly _tag: string = "LedgerServiceError";

    constructor(
        message: string,
        public readonly statusCode?: number,
        public readonly response?: unknown,
        public readonly code?: string,
        options?: LedgerErrorOptions,
    ) {
        super(message, options);
        this.name = "LedgerServiceError";
        Error.captureStackTrace?.(this, this.constructor);
    }
}

export function isLedgerServiceError(e: unknown): e is LedgerServiceError {
    return (
        e instanceof LedgerServiceError ||
        (e as any)?._tag === "LedgerServiceError"
    );
}

// ============================================================================
// Version Conflict Error (HTTP 409)
// ============================================================================

/**
 * Error thrown when a version conflict occurs (HTTP 409)
 */
export class VersionConflictError extends LedgerServiceError {
    override readonly _tag = "VersionConflictError";

    constructor(
        message: string,
        public readonly conflict: ConflictResponse,
        options?: LedgerErrorOptions,
    ) {
        super(message, 409, conflict, conflict.code, options);
        this.name = "VersionConflictError";
        Error.captureStackTrace?.(this, this.constructor);
    }
}

export function isVersionConflictError(e: unknown): e is VersionConflictError {
    return (
        e instanceof VersionConflictError ||
        (e as any)?._tag === "VersionConflictError"
    );
}

// ============================================================================
// Not Found Error (HTTP 404)
// ============================================================================

/**
 * Error thrown when a resource is not found (HTTP 404)
 */
export class NotFoundError extends LedgerServiceError {
    override readonly _tag = "NotFoundError";

    constructor(message: string, code = "not_found", options?: LedgerErrorOptions) {
        super(message, 404, undefined, code, options);
        this.name = "NotFoundError";
        Error.captureStackTrace?.(this, this.constructor);
    }
}

export function isNotFoundError(e: unknown): e is NotFoundError {
    return e instanceof NotFoundError || (e as any)?._tag === "NotFoundError";
}

// ============================================================================
// Authentication Error (HTTP 401/403)
// ============================================================================

/**
 * Error thrown when authentication fails (HTTP 401/403)
 */
export class AuthenticationError extends LedgerServiceError {
    override readonly _tag = "AuthenticationError";

    constructor(
        message: string,
        statusCode: number,
        code = "unauthorized",
        options?: LedgerErrorOptions,
    ) {
        super(message, statusCode, undefined, code, options);
        this.name = "AuthenticationError";
        Error.captureStackTrace?.(this, this.constructor);
    }
}

export class EntityVersionChainError extends LedgerServiceError {
    override readonly _tag = "EntityVersionChainError";

    constructor(public readonly details: EntityVersionChainErrorResponse) {
        super(details.message ?? "Invalid entity version chain", 409, details, details.code);
        this.name = "EntityVersionChainError";
    }
}

export class IdempotencyMismatchError extends LedgerServiceError {
    override readonly _tag = "IdempotencyMismatchError";

    constructor(response: unknown) {
        super("Request ID was reused with different content", 409, response, "idempotency_mismatch");
        this.name = "IdempotencyMismatchError";
    }
}

export function isAuthenticationError(e: unknown): e is AuthenticationError {
    return (
        e instanceof AuthenticationError ||
        (e as any)?._tag === "AuthenticationError"
    );
}
