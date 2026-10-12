import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { verifyAccess } from "../src/auth";
import type { AccessClaims } from "../src/contracts";
import type { JsonObject } from "../src/schemas";

const LEGACY = { contracts: null, dynamicEvents: true, validation: null } as const;

async function source() {
    const registry = env.APP_REGISTRY.getByName("registry-v1");
    const created = await registry.createApplication({ name: `source-${crypto.randomUUID()}`, policy: LEGACY });
    if (!created.ok) throw new Error("could not provision");
    const claims: AccessClaims = await verifyAccess(env, created.body.token);
    const stub = env.LEDGER_APP.getByName(created.body.app.id);
    return { appId: created.body.app.id, claims, stub };
}

const event = (entityId: string, payload: JsonObject, type = "CALENDAR_EVENT_ADDED", baseEntityVersion?: number) => ({
    id: crypto.randomUUID(), type, entityId, payload, ...(baseEntityVersion === undefined ? {} : { baseEntityVersion }),
});
const ACTION = crypto.randomUUID();

/** A source application with two logs, authors, an action batch, a hidden log, and retried requests. */
async function populatedSource() {
    const { appId, claims, stub } = await source();
    const logA = await stub.createLog(claims, { name: "main" });
    const logB = await stub.createLog(claims, { name: "scratch" });
    if (!logA.ok || !logB.ok) throw new Error("could not create logs");
    const visit = `calendar_event:${crypto.randomUUID()}`;
    const requests = {
        first: { requestId: crypto.randomUUID(), events: [event(visit, { id: "a", title: "Dentist", eventDate: "2026-10-12", notes: "5" })] },
        batch: {
            requestId: crypto.randomUUID(),
            actionId: ACTION,
            events: [
                event(visit, { id: "a", notes: "7" }, "CALENDAR_EVENT_UPDATED", 1),
                event(`calendar_event:${crypto.randomUUID()}`, { id: "b", title: "Checkup", eventDate: "2026-10-13", notes: "9" }),
            ],
        },
    };
    const first = await stub.appendEvents(claims, logA.body.id, requests.first, 0, "owner@example.com");
    const batch = await stub.appendEvents(claims, logA.body.id, requests.batch, 0, "partner@example.com");
    if (!first.ok || !batch.ok) throw new Error(`append failed: ${JSON.stringify(first.ok ? batch : first)}`);
    expect((await stub.appendEvents(claims, logB.body.id, { requestId: crypto.randomUUID(), events: [event(`calendar_event:${crypto.randomUUID()}`, { id: "c", title: "Other", eventDate: "2026-10-14" })] })).ok).toBe(true);
    expect((await stub.setLogVisibility(claims, logB.body.id, { hidden: true })).ok).toBe(true);
    return { appId, claims, stub, logs: { main: logA.body.id, scratch: logB.body.id }, requests };
}

async function transferLines(stub: ReturnType<typeof env.LEDGER_APP.getByName>, appId: string): Promise<Array<Record<string, unknown>>> {
    const response = await stub.administratorTransferExport(appId);
    expect(response.status).toBe(200);
    return (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Replays an export into an empty Ledger (a registry of its own) under the original application id. */
async function importInto(registryName: string, lines: Array<Record<string, unknown>>, appId: string) {
    const registry = env.APP_REGISTRY.getByName(registryName);
    const first = lines[0]!;
    const begun = await registry.beginImport({ id: appId, name: String(first.name), createdAt: String(first.createdAt), policy: first.policy ? JSON.stringify(first.policy) : null });
    const records = lines.filter((line) => line.t !== "app" && line.t !== "end");
    const stub = env.LEDGER_APP.getByName(appId);
    return { registry, begun, records, stub };
}

describe("identity-preserving transfer", () => {
    it("exports a stream that starts with the application and ends with its totals", async () => {
        const { appId, stub } = await populatedSource();
        const lines = await transferLines(stub, appId);
        expect(lines[0]).toMatchObject({ t: "app", id: appId, format: "ledger-application-transfer" });
        expect(lines.at(-1)).toMatchObject({ t: "end", logs: 2, events: 4, requests: 3 });
        const events = lines.filter((line) => line.t === "events").flatMap((line) => line.events as Array<{ actor?: string }>);
        expect(events.map((item) => item.actor).sort()).toEqual(["owner@example.com", "partner@example.com", "partner@example.com", undefined]);
    });

    it("moves every identity and the idempotency records, and the checksums match", async () => {
        const source = await populatedSource();
        const lines = await transferLines(source.stub, source.appId);
        // A different application id: one test namespace cannot hold the source and its copy under the same name.
        const targetId = crypto.randomUUID();
        const target = await importInto(`import-${crypto.randomUUID()}`, lines, targetId);
        expect(target.begun.ok).toBe(true);
        const imported = await target.stub.importRecords(targetId, target.records);
        expect(imported).toMatchObject({ ok: true, body: { logs: 2, events: 4, requests: 3 } });
        const finished = await target.registry.finishImport(targetId, {
            logs: target.records.filter((record) => record.t === "log").map((record) => ({ id: String(record.id), headVersion: Number(record.headVersion) })),
        });
        expect(finished).toMatchObject({ ok: true, body: { logs: 2, events: 4 } });

        const before = await source.stub.administratorChecksums(source.appId);
        const after = await target.stub.administratorChecksums(targetId);
        expect(before.ok && after.ok).toBe(true);
        if (before.ok && after.ok) {
            expect(after.body.logs).toEqual(before.body.logs);
            expect(after.body.logs.map((log) => log.eventCount).sort()).toEqual([1, 3]);
        }

        // The copy serves the original log ids, versions and authors, and hidden state.
        const token = await target.registry.rotateApplicationToken(targetId);
        if (!token.ok) throw new Error("no token for the imported application");
        const claims = await verifyAccess(env, token.body.token);
        const listed = await target.stub.listLogs(claims);
        if (!listed.ok) throw new Error("could not list");
        expect(listed.body.logs.map((log) => [log.id, log.headVersion, Boolean(log.hiddenAt)]).sort())
            .toEqual([[source.logs.main, 3, false], [source.logs.scratch, 1, true]].sort());
        const events = await target.stub.listEvents(claims, source.logs.main, 0, 512);
        if (!events.ok) throw new Error("could not read events");
        expect(events.body.events.map((item) => [item.version, item.entityVersion, item.actor, item.action?.id])).toEqual([
            [1, 1, "owner@example.com", undefined], [2, 2, "partner@example.com", ACTION], [3, 1, "partner@example.com", ACTION],
        ]);

        // A device retrying a request it sent before the move is recognized, not applied twice.
        const replay = await target.stub.appendEvents(claims, source.logs.main, source.requests.batch);
        expect(replay).toMatchObject({ ok: true, body: { newVersion: 3 } });
        const changed = { ...source.requests.batch, events: [event(`calendar_event:${crypto.randomUUID()}`, { id: "z", title: "Different", eventDate: "2026-10-15" })] };
        expect(await target.stub.appendEvents(claims, source.logs.main, changed)).toMatchObject({ ok: false, status: 409, body: { code: "idempotency_mismatch" } });
        const head = await target.stub.listEvents(claims, source.logs.main, 0, 512);
        expect(head.ok && head.body.events.length).toBe(3);
    });

    it("refuses an import into a Ledger that already has an application, and one that is out of order or incomplete", async () => {
        const source = await populatedSource();
        const lines = await transferLines(source.stub, source.appId);
        const occupied = env.APP_REGISTRY.getByName("registry-v1");
        expect(await occupied.beginImport({ id: crypto.randomUUID(), name: "x", createdAt: new Date().toISOString(), policy: null }))
            .toMatchObject({ ok: false, status: 409, body: { code: "ledger_not_empty" } });

        const targetId = crypto.randomUUID();
        const target = await importInto(`import-${crypto.randomUUID()}`, lines, targetId);
        const logs = target.records.filter((record) => record.t === "log");
        const events = target.records.filter((record) => record.t === "events");
        // Events before their log, and a gap in versions.
        expect(await target.stub.importRecords(targetId, [events[0]])).toMatchObject({ ok: false, body: { code: "import_order" } });
        await target.stub.importRecords(targetId, logs);
        const gapped = { ...(events.find((record) => (record.events as unknown[]).length === 3) as { events: Array<{ version: number }> }) };
        gapped.events = gapped.events.slice(1);
        expect(await target.stub.importRecords(targetId, [{ ...gapped, t: "events", logId: (events.find((record) => (record.events as unknown[]).length === 3) as { logId: string }).logId }]))
            .toMatchObject({ ok: false, body: { code: "import_gap" } });
        // Finishing with events missing keeps the application closed.
        expect(await target.registry.finishImport(targetId, { logs: logs.map((record) => ({ id: String(record.id), headVersion: Number(record.headVersion) })) }))
            .toMatchObject({ ok: false, body: { code: "import_incomplete" } });
        expect(await target.registry.getApplication(targetId)).toMatchObject({ ok: false, status: 404 });
    });

    it("lets a failed import be aborted and started again, and refuses to abort a finished one", async () => {
        const source = await populatedSource();
        const lines = await transferLines(source.stub, source.appId);
        const registryName = `import-${crypto.randomUUID()}`;
        const targetId = crypto.randomUUID();
        const first = await importInto(registryName, lines, targetId);
        const logs = first.records.filter((record) => record.t === "log");
        expect((await first.stub.importRecords(targetId, logs)).ok).toBe(true);
        expect(await first.registry.abortImport(targetId)).toMatchObject({ ok: true });
        // The Ledger is empty again: the same import runs from the start.
        const again = await importInto(registryName, lines, targetId);
        expect(again.begun.ok).toBe(true);
        expect((await again.stub.importRecords(targetId, again.records)).ok).toBe(true);
        const finished = await again.registry.finishImport(targetId, { logs: logs.map((record) => ({ id: String(record.id), headVersion: Number(record.headVersion) })) });
        expect(finished.ok).toBe(true);
        expect(await again.registry.abortImport(targetId)).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses to export while a fork is still preparing", async () => {
        const { appId, claims, stub } = await source();
        const log = await stub.createLog(claims, { name: "main" });
        if (!log.ok) throw new Error("no log");
        const appended = await stub.appendEvents(claims, log.body.id, { requestId: crypto.randomUUID(), events: [event(`calendar_event:${crypto.randomUUID()}`, { id: "a", title: "Dentist", eventDate: "2026-10-12" })] });
        if (!appended.ok) throw new Error("no append");
        const fork = await stub.forkLog(claims, log.body.id, { name: "later", targetVersion: 1, expectedSourceHeadVersion: 1, requestId: crypto.randomUUID() });
        expect(fork.ok).toBe(true);
        const response = await stub.administratorTransferExport(appId);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "fork_preparing" });
    });
});
