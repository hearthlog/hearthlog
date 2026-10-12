import {
    LedgerError,
    normalizeError,
    type ErrorBody,
} from "./errors";

export interface RpcSuccess<T> {
    ok: true;
    status: number;
    body: T;
}

export interface RpcFailure {
    ok: false;
    status: number;
    body: ErrorBody;
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

export function rpcSuccess<T>(body: T, status = 200): RpcSuccess<T> {
    return { ok: true, status, body };
}

export async function rpcCall<T>(
    operation: () => RpcSuccess<T> | Promise<RpcSuccess<T>>,
): Promise<RpcResult<T>> {
    try {
        return await operation();
    } catch (cause) {
        if (cause instanceof LedgerError) {
            return {
                ok: false,
                status: cause.status,
                body: cause.body,
            };
        }
        // Anything else is a server fault. Reporting it as invalid input would
        // make clients permanently reject changes that a retry could accept.
        throw normalizeError(cause);
    }
}
