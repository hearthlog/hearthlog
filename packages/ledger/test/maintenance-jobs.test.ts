import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCheckpointEvents, type CheckpointEvent } from "@hearthlog/contracts/history/checkpoint";
import { verifyAccess } from "../src/auth";
import { MAX_ATTEMPTS } from "../src/log-maintenance";
import type { RpcResult, RpcSuccess } from "../src/rpc";

async function provision(label: string) {
    const result = await env.APP_REGISTRY.getByName("registry-v1").createApplication({
        name: `${label}-${crypto.randomUUID()}`, policy: { contracts: null, dynamicEvents: true, validation: null },
    });
    expectSuccess(result);
    return { appId: result.body.app.id, claims: await verifyAccess(env, result.body.token) };
}

function expectSuccess<T>(result: RpcResult<T>): asserts result is RpcSuccess<T> {
    if (!result.ok) throw new Error(`expected RPC success, received ${result.status}: ${JSON.stringify(result.body)}`);
}

/** A log with `entities` records edited `edits` times each, one append per edit round. */
async function seedLog(label: string, entities: number, edits: number) {
    const app = await provision(label);
    const stub = env.LEDGER_APP.getByName(app.appId);
    const created = await stub.createLog(app.claims, { name: label });
    expectSuccess(created);
    const logId = created.body.id;
    const ids = Array.from({ length: entities }, () => crypto.randomUUID());
    const versions = new Map<string, number>();
    const editAll = async (round: number) => {
        const events = ids.map(id => {
            const version = versions.get(id) ?? 0;
            versions.set(id, version + 1);
            return { id: crypto.randomUUID(), entityId: `calendar_event:${id}`, type: version ? "CALENDAR_EVENT_UPDATED" : "CALENDAR_EVENT_ADDED",
                ...(version ? { baseEntityVersion: version } : {}), payload: { id, title: `Round ${round}`, eventDate: "2026-10-22" } };
        });
        expectSuccess(await stub.appendEvents(app.claims, logId, { requestId: crypto.randomUUID(), events }, 2));
    };
    for (let round = 0; round < edits; round++) await editAll(round);
    return { app, stub, logId, editAll };
}

async function alarmsUntilDone(stub: ReturnType<typeof env.LEDGER_APP.getByName>, state: () => Promise<{ status?: string } | null | undefined>, limit = 200) {
    for (let index = 0; index < limit; index++) {
        const status = (await state())?.status;
        if (status === "complete" || status === "failed" || status === "paused") return status;
        expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    throw new Error("maintenance did not finish");
}

describe("server-driven log maintenance", () => {
    it("finishes a snapshot and a compaction through alarms alone, with cheap writes", async () => {
        const { app, stub, logId } = await seedLog("alarm-driven", 12, 60); // 720 events
        const status = async () => {
            const state = await stub.logMaintenance(app.claims, logId);
            expectSuccess(state);
            return state.body.job;
        };
        const started = await stub.startLogMaintenance(app.claims, logId, crypto.randomUUID(), "snapshot");
        expectSuccess(started);
        expect(await alarmsUntilDone(stub, status)).toBe("complete");
        const snapshot = await stub.logMaintenance(app.claims, logId);
        expectSuccess(snapshot);
        expect(snapshot.body.checkpoint).toMatchObject({ throughVersion: 720 });
        expect(snapshot.body.checkpoint!.eventCount).toBeLessThan(12 * 6);
        const writes = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ writes: number }>(
            "SELECT writes FROM log_maintenance_jobs WHERE kind = 'snapshot'").one().writes);
        expect(writes).toBeLessThan(720 / 2); // the R2 work-file builder spent ~2 writes per event
        await runInDurableObject(stub, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());

        const preview = await stub.compactionPreview(app.claims, logId);
        expectSuccess(preview);
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, crypto.randomUUID(), "compact", preview.body.checkpointId!, preview.body.storageGeneration));
        expect(await alarmsUntilDone(stub, status)).toBe("complete");
        const compacted = await stub.logMaintenance(app.claims, logId);
        expectSuccess(compacted);
        expect(compacted.body).toMatchObject({ compactedThroughVersion: 720 });
    });

    it("keeps a failing step visible, retries with backoff, stops after repeated failures and resumes on an explicit retry", async () => {
        const { app, stub, logId } = await seedLog("failing", 4, 20);
        const job = async () => {
            const state = await stub.logMaintenance(app.claims, logId);
            expectSuccess(state);
            return state.body.job!;
        };
        await runInDurableObject(stub, (instance) => {
            const app = instance as unknown as { env: any };
            const real = app.env.LEDGER_ARCHIVE;
            app.env = { ...app.env, LEDGER_ARCHIVE: { get: (key: string) => real.get(key), delete: (key: string) => real.delete(key),
                put: (...args: unknown[]) => (globalThis as any).failArchive ? Promise.reject(new Error("injected archive outage")) : real.put(...args) } };
        });
        (globalThis as any).failArchive = true;
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, crypto.randomUUID(), "snapshot"));
        for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
            let current = await job();
            for (let guard = 0; guard < 20 && current.attempts !== attempt; guard++) {
                await runDurableObjectAlarm(stub);
                current = await job();
            }
            expect(current).toMatchObject({ attempts: attempt, error: "injected archive outage" });
            expect(current.status).not.toBe("failed");
            expect(Date.parse(current.retryAt!)).toBeGreaterThan(Date.now());
            // Skip the backoff wait.
            await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE log_maintenance_jobs SET retry_at = ?", new Date(Date.now() - 1).toISOString()); });
        }
        for (let guard = 0; guard < 20 && (await job()).status !== "failed"; guard++) {
            await runDurableObjectAlarm(stub);
            await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE log_maintenance_jobs SET retry_at = ?", new Date(Date.now() - 1).toISOString()); });
        }
        expect(await job()).toMatchObject({ status: "failed", error: "injected archive outage", attempts: MAX_ATTEMPTS });
        await runInDurableObject(stub, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());

        (globalThis as any).failArchive = false;
        const retried = await stub.stepLogMaintenance(app.claims, logId, (await job()).id);
        expectSuccess(retried);
        expect(retried.body.job).toMatchObject({ error: null, attempts: 0 });
        expect(await alarmsUntilDone(stub, async () => await job())).toBe("complete");
    });

    it("seeds a later snapshot from the previous one and matches a full replay of the whole history", async () => {
        const { app, stub, logId, editAll } = await seedLog("seeded", 6, 30);
        const status = async () => {
            const state = await stub.logMaintenance(app.claims, logId);
            expectSuccess(state);
            return state.body.job;
        };
        const run = async (kind: "snapshot" | "compact") => {
            const state = await stub.logMaintenance(app.claims, logId);
            expectSuccess(state);
            expectSuccess(await stub.startLogMaintenance(app.claims, logId, crypto.randomUUID(), kind,
                kind === "compact" ? state.body.checkpoint!.id : undefined, kind === "compact" ? state.body.storageGeneration : undefined));
            expect(await alarmsUntilDone(stub, status)).toBe("complete");
        };
        await run("snapshot");
        await run("compact");
        await editAll(99); await editAll(100);
        await run("snapshot");
        const phase = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ phase: string }>(
            "SELECT phase FROM log_maintenance_jobs WHERE kind = 'snapshot' ORDER BY rowid DESC LIMIT 1").one().phase);
        expect(phase).toBe("pages");

        const state = await stub.logMaintenance(app.claims, logId);
        expectSuccess(state);
        const manifest = state.body.checkpoint!;
        const snapshotEvents: CheckpointEvent[] = [];
        const claims: unknown[] = [];
        for (let index = 0; index < manifest.pages.length; index++) {
            const chunk = await stub.checkpointChunk(app.claims, logId, index);
            expectSuccess(chunk);
            snapshotEvents.push(...(chunk.body.events as unknown as CheckpointEvent[]));
            claims.push(...chunk.body.claims);
        }
        const all = await stub.listEvents(app.claims, logId, 0, 512, 2);
        expectSuccess(all);
        const history: CheckpointEvent[] = [];
        for (let after = 0; ;) {
            const page = await stub.listEvents(app.claims, logId, after, 512, 2);
            expectSuccess(page);
            if (!page.body.events.length) break;
            history.push(...(page.body.events as unknown as CheckpointEvent[]));
            after = page.body.events.at(-1)!.version;
        }
        const expected = buildCheckpointEvents(history, manifest.throughVersion).map(event => event.version);
        expect(snapshotEvents.map(event => event.version).sort((a, b) => a - b)).toEqual(expected);
        expect(claims).toHaveLength(6);
    });
});
