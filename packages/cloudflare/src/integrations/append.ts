import type { ServiceAppend } from "@hearthlog/contracts";
import { IntegrationRequestError } from "@hearthlog/contracts/integrations/service";

/** Highest replay version this Worker understands; a log with restores still accepts it. */
const REPLAY_VERSION = "2";
const MAX_ATTEMPTS = 3;

export interface AppendEnv {
    LEDGER: { fetch(request: Request): Promise<Response> };
    LEDGER_AUTH_TOKEN: string;
}

interface LedgerRejection {
    code?: unknown;
    expectedBaseEntityVersion?: unknown;
    currentEntityVersion?: unknown;
}

/**
 * Create or update one entity as a service identity.
 *
 * Ledger appends are not upserts: an update must name the entity's current
 * version. The first attempt creates; if the entity exists, Ledger's rejection
 * carries the version to continue from, and the Worker sends the update once
 * with it. A race with a browser edit is retried the same way, a few times.
 * Nothing is stored between calls.
 */
export async function upsertEntity(
    env: AppendEnv,
    options: {
        logId: string;
        actor: string;
        build(base: number | undefined): Promise<ServiceAppend>;
    },
): Promise<"created" | "updated"> {
    let base: number | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const append = await options.build(base);
        const response = await send(env, options.logId, options.actor, append);
        if (response.ok) return base === undefined ? "created" : "updated";

        const rejection = await readRejection(response);
        const next = continuationVersion(response.status, rejection);
        if (next === undefined) throw ledgerError(response.status, rejection);
        base = next;
    }
    throw new IntegrationRequestError(409, "entity_conflict", "The day changed while it was being saved; try again");
}

function send(env: AppendEnv, logId: string, actor: string, append: ServiceAppend): Promise<Response> {
    return env.LEDGER.fetch(
        new Request(`https://ledger.internal/logs/${encodeURIComponent(logId)}/events`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}`,
                "Content-Type": "application/json",
                "X-Ledger-Actor": actor,
                "X-Ledger-Replay-Version": REPLAY_VERSION,
            },
            body: JSON.stringify(append),
        }),
    ).catch(() => {
        throw new IntegrationRequestError(503, "ledger_unavailable", "Ledger could not be reached");
    });
}

async function readRejection(response: Response): Promise<LedgerRejection> {
    try {
        const value: unknown = await response.json();
        return value !== null && typeof value === "object" ? (value as LedgerRejection) : {};
    } catch {
        return {};
    }
}

/** The entity version a rejected append says to continue from, when it says one. */
function continuationVersion(status: number, rejection: LedgerRejection): number | undefined {
    if (status !== 409) return undefined;
    const version = rejection.code === "invalid_entity_version_chain"
        ? rejection.expectedBaseEntityVersion
        : rejection.code === "entity_conflict"
            ? rejection.currentEntityVersion
            : undefined;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}

function ledgerError(status: number, rejection: LedgerRejection): IntegrationRequestError {
    if (status === 404) return new IntegrationRequestError(404, "log_not_found", "The configured log was not found");
    if (status === 409 && rejection.code === "fork_preparing") {
        return new IntegrationRequestError(503, "fork_preparing", "The log is preparing; try again shortly");
    }
    if (status === 409) return new IntegrationRequestError(409, "ledger_conflict", "Ledger rejected the update");
    return new IntegrationRequestError(502, "ledger_failed", "Ledger could not save the update");
}
