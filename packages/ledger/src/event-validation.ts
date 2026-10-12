import { EVENT_OWNERS, EVENT_SCHEMAS, type EventSchema, type PayloadKind } from "#generated/event-schemas";

/**
 * `report` logs what `enforce` would reject and accepts the append. Rejection
 * turns a client's saved change into a rejected local batch, so the mode
 * switches per deployment: watch the logs in `report`, then enforce.
 */
export type EventValidationMode = "report" | "enforce";

export interface PayloadViolation {
    /** Zero-based position of the event in the request. */
    index: number;
    type: string;
    /** Names a key or a rule, never a value, so it is safe to log. */
    problem: string;
}

const META_TYPES = new Set([
    "ENTITY_TYPE_DEFINED",
    "ENTITY_TYPE_UPDATED",
    "ENTITY_TYPE_ARCHIVED",
]);
const DIRECTIVE_TYPES = new Set(["EVENTS_EXCISED", "WORKSPACE_RESTORED"]);
// Entity types defined at runtime have no schema here: only their shape is checked.
const DYNAMIC_TYPE = /^[A-Z][A-Z0-9_]{0,95}_(?:ADDED|UPDATED|REMOVED)$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DYNAMIC_KEYS = 256;
const MAX_KEY_LENGTH = 128;
const MAX_DYNAMIC_FIELDS = 200;

export function eventValidationMode(value: unknown): EventValidationMode {
    return value === "enforce" ? "enforce" : "report";
}

/**
 * What one application may append. Applications created before policies
 * existed have none and keep the Worker's behavior: every contract, runtime
 * entity types, and the deployment's validation mode.
 */
export interface EventPolicy {
    /** Modules whose event types are accepted; the core's always are. Null accepts every module. */
    contracts: string[] | null;
    /** Runtime-defined entity types (`ENTITY_TYPE_DEFINED` and their events). */
    dynamicEvents: boolean;
    /** Null follows the deployment's `EVENT_VALIDATION`. */
    validation: EventValidationMode | null;
}

/** What an application created without an explicit policy gets: modules unrestricted, nothing undeclared, violations rejected. */
export const NEW_APPLICATION_POLICY: EventPolicy = { contracts: null, dynamicEvents: false, validation: "enforce" };

export function parseEventPolicy(value: unknown): EventPolicy | null {
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value) as Partial<EventPolicy>;
        return {
            contracts: Array.isArray(parsed.contracts) ? parsed.contracts.filter((id): id is string => typeof id === "string") : null,
            dynamicEvents: parsed.dynamicEvents !== false,
            validation: parsed.validation === "enforce" || parsed.validation === "report" ? parsed.validation : null,
        };
    } catch {
        return null;
    }
}

/** The mode an append is checked in: the application's own, else the deployment's. */
export function effectiveValidationMode(policy: EventPolicy | null, deployment: unknown): EventValidationMode {
    return policy?.validation ?? eventValidationMode(deployment);
}

/** The event contracts a Worker is built with: the generated ones, or a test's own. */
export interface EventContracts {
    schemas: Readonly<Record<string, EventSchema>>;
    owners: Readonly<Record<string, string>>;
}

const GENERATED_CONTRACTS: EventContracts = { schemas: EVENT_SCHEMAS, owners: EVENT_OWNERS };

export function findPayloadViolations(
    events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
    limit = 5,
    policy: EventPolicy | null = null,
    contracts: EventContracts = GENERATED_CONTRACTS,
): PayloadViolation[] {
    const violations: PayloadViolation[] = [];
    for (const [index, event] of events.entries()) {
        for (const problem of eventProblems(event.type, event.payload, policy, contracts)) {
            violations.push({ index, type: event.type, problem });
            if (violations.length >= limit) return violations;
        }
    }
    return violations;
}

function eventProblems(type: string, payload: Record<string, unknown>, policy: EventPolicy | null, contracts: EventContracts): string[] {
    const schema = contracts.schemas[type];
    if (schema) {
        const owner = contracts.owners[type];
        if (policy?.contracts && owner && owner !== "core" && !policy.contracts.includes(owner)) {
            return [`event type is not part of this application's modules (${owner})`];
        }
        const problems = requireId(payload);
        for (const [key, kind] of Object.entries(schema.fields)) {
            const value = payload[key];
            if (value === undefined || value === null) continue;
            if (!matchesKind(value, kind)) problems.push(`${key} must be a ${kind}`);
        }
        if (schema.kind === "added") {
            for (const key of schema.required) {
                if (payload[key] === undefined || payload[key] === null) problems.push(`${key} is required`);
            }
        }
        return problems;
    }
    if (type === "EVENT_TOMBSTONED") {
        return typeof payload.eventId === "string" && payload.eventId !== ""
            ? []
            : ["eventId must be a string"];
    }
    if (DIRECTIVE_TYPES.has(type)) return [];
    if (policy && !policy.dynamicEvents && (META_TYPES.has(type) || DYNAMIC_TYPE.test(type))) {
        return ["unknown event type"];
    }
    if (META_TYPES.has(type)) return metaProblems(type, payload);
    if (DYNAMIC_TYPE.test(type)) return dynamicProblems(payload);
    return ["unknown event type"];
}

function requireId(payload: Record<string, unknown>): string[] {
    return typeof payload.id === "string" && payload.id !== "" ? [] : ["id must be a string"];
}

function matchesKind(value: unknown, kind: PayloadKind): boolean {
    switch (kind) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "boolean":
            // SQLite stores booleans as 0 and 1, and older senders wrote them that way.
            return typeof value === "boolean" || value === 0 || value === 1;
    }
}

function metaProblems(type: string, payload: Record<string, unknown>): string[] {
    const problems = requireId(payload);
    if (type !== "ENTITY_TYPE_DEFINED") return problems;
    for (const key of ["name", "tableName"] as const) {
        const value = payload[key];
        if (typeof value !== "string" || !IDENTIFIER.test(value)) problems.push(`${key} must be a lowercase identifier`);
    }
    if (typeof payload.displayName !== "string" || payload.displayName === "") {
        problems.push("displayName must be a string");
    }
    const fields = payload.fields;
    if (!Array.isArray(fields)) {
        problems.push("fields must be a list");
    } else if (fields.length > MAX_DYNAMIC_FIELDS) {
        problems.push(`fields has more than ${MAX_DYNAMIC_FIELDS} entries`);
    } else if (fields.some((field) => !isRecord(field) || typeof field.name !== "string" || !IDENTIFIER.test(field.name))) {
        problems.push("every field needs a lowercase identifier name");
    }
    return problems;
}

function dynamicProblems(payload: Record<string, unknown>): string[] {
    const problems = requireId(payload);
    const keys = Object.keys(payload);
    if (keys.length > MAX_DYNAMIC_KEYS) problems.push(`payload has more than ${MAX_DYNAMIC_KEYS} keys`);
    if (keys.some((key) => key.length > MAX_KEY_LENGTH)) problems.push(`a payload key is longer than ${MAX_KEY_LENGTH} characters`);
    const nested = keys.find((key) => {
        const value = payload[key];
        return value !== null && typeof value === "object";
    });
    if (nested !== undefined) problems.push(`${nested.slice(0, MAX_KEY_LENGTH)} must be a string, number, boolean or null`);
    return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
