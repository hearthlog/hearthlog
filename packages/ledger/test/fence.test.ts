import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { verifyAccess } from "../src/auth";

async function app() {
    const registry = env.APP_REGISTRY.getByName("registry-v1");
    const created = await registry.createApplication({ name: `fence-${crypto.randomUUID()}`, policy: { contracts: null, dynamicEvents: true, validation: null } });
    if (!created.ok) throw new Error("could not provision");
    const claims = await verifyAccess(env, created.body.token);
    const stub = env.LEDGER_APP.getByName(created.body.app.id);
    const log = await stub.createLog(claims, { name: "main" });
    if (!log.ok) throw new Error("no log");
    const request = () => ({
        requestId: crypto.randomUUID(),
        events: [{ id: crypto.randomUUID(), type: "CALENDAR_EVENT_ADDED", entityId: `calendar_event:${crypto.randomUUID()}`, payload: { id: "a", title: "Dentist", eventDate: "2026-10-12" } }],
    });
    const append = (body = request()) => stub.appendEvents(claims, log.body.id, body);
    return { registry, appId: created.body.app.id, claims, stub, logId: log.body.id, append, request };
}

describe("write fence", () => {
    it("pauses writes with a transient 503, keeps reads open, and lets the same request land once afterwards", async () => {
        const { registry, appId, claims, stub, logId, append, request } = await app();
        const waiting = request();
        expect((await append()).ok).toBe(true);

        expect(await registry.setApplicationFence(appId, { mode: "tenant_migrating" })).toMatchObject({ ok: true, body: { fence: { mode: "tenant_migrating", destination: null } } });
        expect(await append(waiting)).toMatchObject({ ok: false, status: 503, body: { code: "tenant_migrating", retryAfterSeconds: 30 } });
        expect(await stub.createLog(claims, { name: "later" })).toMatchObject({ ok: false, status: 503 });
        expect(await stub.setLogVisibility(claims, logId, { hidden: true })).toMatchObject({ ok: false, status: 503 });
        expect(await stub.deleteLog(claims, logId)).toMatchObject({ ok: false, status: 503 });
        // Reads, and the session that tells the gateway, stay open.
        expect((await stub.listLogs(claims)).ok).toBe(true);
        expect((await stub.listEvents(claims, logId, 0, 512)).ok).toBe(true);
        expect(await stub.getSession(claims)).toMatchObject({ ok: true, body: { fence: { mode: "tenant_migrating" } } });

        expect((await registry.setApplicationFence(appId, { mode: "off" })).ok).toBe(true);
        const landed = await append(waiting);
        expect(landed).toMatchObject({ ok: true, body: { newVersion: 2 } });
        // The retry that waited out the pause is recognized, not applied a second time.
        expect(await append(waiting)).toMatchObject({ ok: true, body: { newVersion: 2 } });
        const events = await stub.listEvents(claims, logId, 0, 512);
        expect(events.ok && events.body.events.length).toBe(2);
        expect(await stub.getSession(claims)).toMatchObject({ ok: true });
        const session = await stub.getSession(claims);
        expect(session.ok && "fence" in session.body).toBe(false);
    });

    it("answers a moved workspace with 410 and where it went, and only accepts an HTTPS origin", async () => {
        const { registry, appId, claims, stub, append } = await app();
        expect(await registry.setApplicationFence(appId, { mode: "moved" })).toMatchObject({ ok: false, status: 400 });
        expect(await registry.setApplicationFence(appId, { mode: "moved", destination: "http://example.com" })).toMatchObject({ ok: false, status: 400 });
        expect(await registry.setApplicationFence(appId, { mode: "moved", destination: "https://example.com/path" })).toMatchObject({ ok: false, status: 400 });
        expect(await registry.setApplicationFence(appId, { mode: "tenant_migrating", destination: "https://example.com" })).toMatchObject({ ok: false, status: 400 });
        expect((await registry.setApplicationFence(appId, { mode: "moved", destination: "https://new.example.com" })).ok).toBe(true);
        expect(await append()).toMatchObject({ ok: false, status: 410, body: { code: "tenant_moved", destination: "https://new.example.com" } });
        expect(await stub.getSession(claims)).toMatchObject({ ok: true, body: { fence: { mode: "moved", destination: "https://new.example.com" } } });
        expect(await registry.getApplicationFence(appId)).toMatchObject({ ok: true, body: { fence: { mode: "moved" } } });
    });
});
