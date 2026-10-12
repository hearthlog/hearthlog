/**
 * Server-verified Ledger scope for private Worker storage.
 *
 * Private objects are keyed by the Ledger application, log and entity ids that
 * the Worker itself resolves through the LEDGER service binding. A request
 * parameter is never used as a bucket key without this verification.
 */

export interface LedgerScopeEnv {
    LEDGER: Env["LEDGER"];
    LEDGER_AUTH_TOKEN: Env["LEDGER_AUTH_TOKEN"];
}

export class LedgerScopeError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "LedgerScopeError";
        this.status = status;
        this.code = code;
    }
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && new RegExp(`^${UUID_PATTERN}$`).test(value);
}

/**
 * Resolve the Ledger application id for one log and confirm the log exists in
 * that scope. Throws `LedgerScopeError` with the public status/code pair.
 */
export async function verifyLogAppId(
    logId: string,
    env: LedgerScopeEnv,
): Promise<string> {
    const headers = { Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}` };
    let session: Response;
    try {
        session = await env.LEDGER.fetch(
            new Request("https://ledger.internal/session", { headers }),
        );
    } catch {
        throw unavailableError();
    }
    if (!session.ok) throw unavailableError();

    let sessionValue: unknown;
    try {
        sessionValue = await session.json();
    } catch {
        throw unavailableError();
    }
    if (
        !sessionValue ||
        typeof sessionValue !== "object" ||
        !("appId" in sessionValue) ||
        !isUuid(sessionValue.appId)
    ) {
        throw unavailableError();
    }

    let log: Response;
    try {
        log = await env.LEDGER.fetch(
            new Request(
                `https://ledger.internal/logs/${encodeURIComponent(logId)}`,
                { headers },
            ),
        );
    } catch {
        throw unavailableError();
    }
    if (log.status === 404) {
        throw new LedgerScopeError(404, "log_not_found", "The selected log was not found");
    }
    if (!log.ok) throw unavailableError();
    return sessionValue.appId;
}

function unavailableError(): LedgerScopeError {
    return new LedgerScopeError(
        503,
        "ledger_verification_failed",
        "The selected log could not be verified",
    );
}
