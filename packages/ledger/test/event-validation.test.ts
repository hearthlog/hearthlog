import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { verifyAccess } from "../src/auth";
import { type AccessClaims } from "../src/contracts";
import { EVENT_OWNERS, EVENT_SCHEMAS } from "#generated/event-schemas";
import {
    type EventContracts,
    effectiveValidationMode,
    eventValidationMode,
    findPayloadViolations,
    NEW_APPLICATION_POLICY,
    parseEventPolicy,
    type EventPolicy,
} from "../src/event-validation";
import type { JsonObject } from "../src/schemas";

// Contracts of two made-up modules, so the rules are shown without naming any real one.
const SYNTHETIC: EventContracts = {
    schemas: {
        TEST_AMOUNT_ADDED: { kind: "added", entity: "test_amount", required: ["name", "amount"], fields: { name: "string", amount: "number" } },
        TEST_AMOUNT_UPDATED: { kind: "updated", entity: "test_amount", required: [], fields: { name: "string", amount: "number" } },
        TEST_FLAG_UPDATED: { kind: "updated", entity: "test_flag", required: [], fields: { favorite: "boolean" } },
    },
    owners: { TEST_AMOUNT_ADDED: "test.first", TEST_AMOUNT_UPDATED: "test.first", TEST_FLAG_UPDATED: "test.second" },
};

const check = (type: string, payload: Record<string, unknown>, contracts?: EventContracts) =>
    findPayloadViolations([{ type, payload }], 5, null, contracts).map((violation) => violation.problem);

/** A valid payload for an event type, built from its generated schema. */
function samplePayload(type: string): Record<string, unknown> {
    const schema = EVENT_SCHEMAS[type]!;
    const sample = { string: "x", number: 1, boolean: true } as const;
    const payload: Record<string, unknown> = { id: "id-1" };
    for (const key of schema.required) payload[key] = sample[schema.fields[key]!];
    return payload;
}

/** An event of some installed module, when there is one (a core-only install has none). */
const foreign = Object.entries(EVENT_OWNERS).find(([type, owner]) => owner !== "core" && EVENT_SCHEMAS[type]!.kind === "added");

describe("event payload validation", () => {
    it("accepts a valid payload for every generated event type", () => {
        for (const type of Object.keys(EVENT_SCHEMAS)) expect(check(type, samplePayload(type)), type).toEqual([]);
    });

    it("names the module or the core that defines every generated event type", () => {
        expect(Object.keys(EVENT_OWNERS).sort()).toEqual(Object.keys(EVENT_SCHEMAS).sort());
        expect(EVENT_OWNERS.CALENDAR_EVENT_ADDED).toBe("core");
    });

    it("checks the kind of declared keys and the required keys of an add", () => {
        expect(check("TEST_AMOUNT_ADDED", { id: "a", name: "Cash", amount: 5 }, SYNTHETIC)).toEqual([]);
        expect(check("TEST_AMOUNT_ADDED", { id: "a", name: "Cash", amount: "five" }, SYNTHETIC)).toEqual(["amount must be a number"]);
        expect(check("TEST_AMOUNT_ADDED", { id: "a", name: "Cash" }, SYNTHETIC)).toEqual(["amount is required"]);
        expect(check("TEST_AMOUNT_ADDED", { id: "a", name: null, amount: 1 }, SYNTHETIC)).toEqual(["name is required"]);
        expect(check("TEST_AMOUNT_UPDATED", { id: "a", amount: null }, SYNTHETIC)).toEqual([]);
        expect(check("TEST_AMOUNT_UPDATED", { amount: 1 }, SYNTHETIC)).toEqual(["id must be a string"]);
    });

    it("allows extra keys, null on optional keys, and 0 or 1 for booleans", () => {
        expect(check("TEST_AMOUNT_UPDATED", { id: "a", fromANewerClient: { nested: true } }, SYNTHETIC)).toEqual([]);
        expect(check("TEST_FLAG_UPDATED", { id: "p", favorite: 1 }, SYNTHETIC)).toEqual([]);
        expect(check("TEST_FLAG_UPDATED", { id: "p", favorite: "yes" }, SYNTHETIC)).toEqual(["favorite must be a boolean"]);
    });

    it("rejects unknown types but accepts directives and runtime-defined entities", () => {
        expect(check("USER_CREATED", { id: "u" })).toEqual(["unknown event type"]);
        expect(check("WORKSPACE_RESTORED", { targetVersion: 1 })).toEqual([]);
        expect(check("EVENT_TOMBSTONED", { eventId: "e" })).toEqual([]);
        expect(check("EVENT_TOMBSTONED", {})).toEqual(["eventId must be a string"]);
        expect(check("RECIPE_ADDED", { id: "r", title: "Soup", servings: 4, vegan: null })).toEqual([]);
        expect(check("RECIPE_ADDED", { id: "r", steps: ["a"] })).toEqual(["steps must be a string, number, boolean or null"]);
    });

    it("bounds entity type definitions", () => {
        const defined = {
            id: "t", name: "recipe", displayName: "Recipes", tableName: "recipes",
            fields: [{ name: "title", payloadKey: "title", type: "string" }],
        };
        expect(check("ENTITY_TYPE_DEFINED", defined)).toEqual([]);
        expect(check("ENTITY_TYPE_DEFINED", { ...defined, tableName: "recipes; DROP TABLE x" }))
            .toEqual(["tableName must be a lowercase identifier"]);
        expect(check("ENTITY_TYPE_DEFINED", { ...defined, fields: "title" })).toEqual(["fields must be a list"]);
        expect(check("ENTITY_TYPE_DEFINED", { ...defined, fields: Array.from({ length: 201 }, (_, i) => ({ name: `f${i}` })) }))
            .toEqual(["fields has more than 200 entries"]);
    });

    it("reports what is wrong without echoing values", () => {
        const [violation] = findPayloadViolations([{ type: "TEST_AMOUNT_ADDED", payload: { id: "a", name: "Cash", amount: "secret-value" } }], 5, null, SYNTHETIC);
        expect(violation).toEqual({ index: 0, type: "TEST_AMOUNT_ADDED", problem: "amount must be a number" });
        expect(JSON.stringify(violation)).not.toContain("secret-value");
    });

    it("enforces only when the deployment says so", () => {
        expect(eventValidationMode("enforce")).toBe("enforce");
        expect(eventValidationMode("report")).toBe("report");
        expect(eventValidationMode(undefined)).toBe("report");
    });
});

describe("append validation in Ledger", () => {
    it("rejects with 422 in enforce mode, reports otherwise, and always replays accepted requests", async () => {
        // An application with no say of its own follows the deployment, as every application did before policies.
        const created = await env.APP_REGISTRY.getByName("registry-v1").createApplication({
            name: `validation-${crypto.randomUUID()}`,
            policy: { contracts: null, dynamicEvents: true, validation: null },
        });
        if (!created.ok) throw new Error("could not provision");
        const claims: AccessClaims = await verifyAccess(env, created.body.token);
        const stub = env.LEDGER_APP.getByName(created.body.app.id);
        const log = await stub.createLog(claims, { name: "validated" });
        if (!log.ok) throw new Error("could not create log");
        const request = (payload: JsonObject) => ({
            requestId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "CALENDAR_EVENT_ADDED", entityId: `calendar_event:${crypto.randomUUID()}`, payload }],
        });
        const invalid = { id: "a", title: "Dentist", eventDate: "2026-10-12", pinned: "yes" };

        const reported = await stub.appendEvents(claims, log.body.id, request(invalid));
        expect(reported.ok).toBe(true);

        const accepted = request({ id: "b", title: "Dentist", eventDate: "2026-10-12", pinned: true });
        expect((await stub.appendEvents(claims, log.body.id, accepted)).ok).toBe(true);

        const outcome = await runInDurableObject(stub, async (instance) => {
            const mutable = instance as unknown as { env: { EVENT_VALIDATION: string } };
            const previous = mutable.env.EVENT_VALIDATION;
            mutable.env.EVENT_VALIDATION = "enforce";
            try {
                return {
                    rejected: await instance.appendEvents(claims, log.body.id, request(invalid)),
                    replayed: await instance.appendEvents(claims, log.body.id, accepted),
                };
            } finally {
                mutable.env.EVENT_VALIDATION = previous;
            }
        });
        expect(outcome.rejected).toMatchObject({ ok: false, status: 422, body: { code: "invalid_event_payload", message: "event 1 (CALENDAR_EVENT_ADDED): pinned must be a boolean" } });
        expect(outcome.replayed.ok).toBe(true);
    });
});

describe("per-application event policy", () => {
    const only = (...contracts: string[]): EventPolicy => ({ contracts, dynamicEvents: false, validation: "enforce" });
    const problems = (type: string, payload: Record<string, unknown>, policy: EventPolicy | null) =>
        findPayloadViolations([{ type, payload }], 5, policy).map((violation) => violation.problem);

    it("accepts the core's events and a listed module's, and refuses another module's", () => {
        const policy = only("test.second");
        const added = { id: "a", name: "Cash", amount: 5 };
        const problemsFor = (type: string, payload: Record<string, unknown>, with_: EventPolicy | null) =>
            findPayloadViolations([{ type, payload }], 5, with_, SYNTHETIC).map((violation) => violation.problem);
        expect(problemsFor("TEST_FLAG_UPDATED", { id: "f", favorite: true }, policy)).toEqual([]);
        expect(problemsFor("TEST_AMOUNT_ADDED", added, policy)).toEqual(["event type is not part of this application's modules (test.first)"]);
        expect(problemsFor("TEST_AMOUNT_ADDED", added, only("test.first"))).toEqual([]);
        expect(problemsFor("TEST_AMOUNT_ADDED", added, null)).toEqual([]);
        expect(problems("CALENDAR_EVENT_ADDED", { id: "c", title: "Dentist", eventDate: "2026-10-07" }, policy)).toEqual([]);
    });

    it("lets runtime-defined entity types through only when the application declares the capability", () => {
        const defined = { id: "t", name: "book", tableName: "books", displayName: "Book", fields: [] };
        expect(problems("ENTITY_TYPE_DEFINED", defined, { ...only(), dynamicEvents: true })).toEqual([]);
        expect(problems("ENTITY_TYPE_DEFINED", defined, only())).toEqual(["unknown event type"]);
        expect(problems("BOOK_ADDED", { id: "b" }, only())).toEqual(["unknown event type"]);
        expect(problems("BOOK_ADDED", { id: "b" }, null)).toEqual([]);
        // Directives and tombstones are the platform's, never a capability.
        expect(problems("EVENT_TOMBSTONED", { eventId: "e" }, only())).toEqual([]);
        expect(problems("WORKSPACE_RESTORED", {}, only())).toEqual([]);
    });

    it("reads a stored policy leniently and decides the mode from the policy first", () => {
        expect(parseEventPolicy(null)).toBeNull();
        expect(parseEventPolicy("not json")).toBeNull();
        expect(parseEventPolicy(JSON.stringify(NEW_APPLICATION_POLICY))).toEqual(NEW_APPLICATION_POLICY);
        expect(effectiveValidationMode(NEW_APPLICATION_POLICY, "report")).toBe("enforce");
        expect(effectiveValidationMode({ ...NEW_APPLICATION_POLICY, validation: null }, "enforce")).toBe("enforce");
        expect(effectiveValidationMode(null, "report")).toBe("report");
    });

    it.skipIf(!foreign)("rejects a disallowed append for a new application even where the deployment only reports, and follows policy changes", async () => {
        const [foreignType, foreignOwner] = foreign!;
        const registry = env.APP_REGISTRY.getByName("registry-v1");
        const created = await registry.createApplication({ name: `policy-${crypto.randomUUID()}`, policy: only() });
        if (!created.ok) throw new Error("could not provision");
        const claims: AccessClaims = await verifyAccess(env, created.body.token);
        const stub = env.LEDGER_APP.getByName(created.body.app.id);
        const log = await stub.createLog(claims, { name: "policy" });
        if (!log.ok) throw new Error("could not create log");
        const append = (type: string, payload: JsonObject) => stub.appendEvents(claims, log.body.id, {
            requestId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type, entityId: `x:${crypto.randomUUID()}`, payload }],
        });
        const modulePayload = samplePayload(foreignType) as JsonObject;

        expect(await append(foreignType, modulePayload)).toMatchObject({ ok: false, status: 422, body: { code: "invalid_event_payload" } });
        expect((await append("CALENDAR_EVENT_ADDED", { id: "c", title: "Dentist", eventDate: "2026-10-07" })).ok).toBe(true);

        const widened = await registry.setApplicationPolicy(created.body.app.id, only(foreignOwner));
        expect(widened.ok).toBe(true);
        expect((await append(foreignType, modulePayload)).ok).toBe(true);
        expect(await registry.getApplicationPolicy(created.body.app.id)).toMatchObject({ ok: true, body: { policy: only(foreignOwner) } });
    });

    it("gives an application created without a policy the strict default", async () => {
        const registry = env.APP_REGISTRY.getByName("registry-v1");
        const created = await registry.createApplication({ name: `default-${crypto.randomUUID()}` });
        if (!created.ok) throw new Error("could not provision");
        expect(await registry.getApplicationPolicy(created.body.app.id)).toMatchObject({ ok: true, body: { policy: NEW_APPLICATION_POLICY } });
    });
});
