export type ErrorValue = string | number | boolean | null;
export type ErrorBody = Record<string, ErrorValue>;

export class LedgerError extends Error {
    constructor(
        readonly status: number,
        readonly body: ErrorBody,
    ) {
        super(
            typeof body.message === "string"
                ? body.message
                : typeof body.error === "string"
                  ? body.error
                  : "Ledger request failed",
        );
        this.name = "LedgerError";
    }
}

export function validationError(message: string): LedgerError {
    return new LedgerError(400, {
        error: "ValidationError",
        code: "validation_error",
        message,
    });
}

export function invalidEvent(message: string): LedgerError {
    return new LedgerError(400, {
        error: "ValidationError",
        code: "invalid_event_envelope",
        message,
    });
}

export function errorResponse(error: LedgerError): Response {
    return Response.json(error.body, { status: error.status });
}

export function jsonError(
    code: string,
    message: string,
    status: number,
): Response {
    return Response.json({ error: message, code }, { status });
}

export function normalizeError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
}
