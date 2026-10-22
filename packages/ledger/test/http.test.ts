import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import appendHashFixture from "../contracts/append-hash.json";
import { verifyAccess } from "../src/auth";
import { type AccessClaims, decodeRpc } from "../src/contracts";
import { hashAppendRequest } from "../src/domain";
import { FILE_REFERENCES } from "#generated/event-schemas";
import { type RpcResult, type RpcSuccess, rpcCall } from "../src/rpc";
import { appendEventsBody } from "../src/schemas";
import { sqliteExport, SQL_EXPORT_COMPLETE } from "../src/sqlite-export";
import { actionBatches, restoreBatchRequest } from "../src/action-batches";

interface ProvisionedApplication {
    appId: string;
    claims: AccessClaims;
    token: string;
}

// An installed module's event that names an immutable file version (a core-only install has none).
const fileEvent = Object.entries(FILE_REFERENCES).find(([type]) => type.endsWith('_ADDED'));

describe("Ledger Durable Object RPC", () => {
    it('keeps appends above a snapshot boundary and advances compaction without rewriting the existing archive', async () => {
        const app = await provision('checkpoint-suffix');
        const stub = env.LEDGER_APP.getByName(app.appId);
        const created = await stub.createLog(app.claims, { name: 'Suffix' });
        expectSuccess(created);
        const logId = created.body.id, recordId = crypto.randomUUID();
        const append = (title: string, version: number) => stub.appendEvents(app.claims, logId, {
            requestId: crypto.randomUUID(), events: [{ id: crypto.randomUUID(), entityId: `calendar_event:${recordId}`,
                type: version ? 'CALENDAR_EVENT_UPDATED' : 'CALENDAR_EVENT_ADDED', ...(version ? { baseEntityVersion: version } : {}),
                payload: { id: recordId, title, eventDate: '2026-10-22' } }],
        }, 2);
        const first = await append('First', 0); expectSuccess(first);
        const snapshotId = crypto.randomUUID();
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, snapshotId, 'snapshot'));
        expectSuccess(await stub.stepLogMaintenance(app.claims, logId, snapshotId));
        const second = await append('While snapshot builds', 1); expectSuccess(second);
        const finish = async (id: string) => {
            for (let step = 0; step < 30; step++) {
                const result = await stub.stepLogMaintenance(app.claims, logId, id); expectSuccess(result);
                if (result.body.job?.status === 'complete') return result.body;
                expect(result.body.job?.status).not.toBe('failed');
            }
            throw new Error('Maintenance failed to complete');
        };
        expect((await finish(snapshotId)).checkpoint?.throughVersion).toBe(1);
        const compactId = crypto.randomUUID();
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, compactId, 'compact', snapshotId, 0));
        expect(await stub.startLogMaintenance(app.claims, logId, crypto.randomUUID(), 'snapshot')).toMatchObject({ ok: false, status: 409 });
        expect((await finish(compactId)).compactedThroughVersion).toBe(1);
        const originalKey = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ archive_key: string }>(
            'SELECT archive_key FROM log_events WHERE log_id = ? AND version = 1', logId).one().archive_key);
        const nextSnapshot = crypto.randomUUID(), nextCompact = crypto.randomUUID();
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, nextSnapshot, 'snapshot'));
        expect((await finish(nextSnapshot)).checkpoint?.throughVersion).toBe(2);
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, nextCompact, 'compact', nextSnapshot, 1));
        expect(await finish(nextCompact)).toMatchObject({ compactedThroughVersion: 2, storageGeneration: 2 });
        expect(await finish(nextCompact)).toMatchObject({ storageGeneration: 2 });
        expect(await stub.listEvents(app.claims, logId, 0, 512, 2)).toMatchObject({ ok: true,
            body: { events: [...first.body.events, ...second.body.events] } });
        await runInDurableObject(stub, (_instance, state) => expect(state.storage.sql.exec<{ archive_key: string }>(
            'SELECT archive_key FROM log_events WHERE log_id = ? AND version = 1', logId).one().archive_key).toBe(originalKey));
    });

    it('snapshots, resumes compaction, preserves receipt replay and exports original events after archiving', async () => {
        const app = await provision('checkpoint');
        const stub = env.LEDGER_APP.getByName(app.appId);
        const created = await stub.createLog(app.claims, { name: 'Snapshot source' });
        expectSuccess(created);
        const logId = created.body.id, recordId = crypto.randomUUID();
        const request = { requestId: crypto.randomUUID(), actionId: crypto.randomUUID(), events: Array.from({ length: 300 }, (_, index) => ({
            id: crypto.randomUUID(), type: index === 0 ? 'CALENDAR_EVENT_ADDED' : 'CALENDAR_EVENT_UPDATED', entityId: `calendar_event:${recordId}`,
            ...(index ? { baseEntityVersion: index } : {}), payload: { id: recordId, eventDate: '2026-10-22', title: `Title ${index}`, optional: index === 299 ? null : 'value' },
        })) };
        const accepted = await stub.appendEvents(app.claims, logId, request, 2);
        expectSuccess(accepted);
        const before = await stub.administratorChecksums(app.appId);
        expectSuccess(before);
        const snapshotId = crypto.randomUUID();
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, snapshotId, 'snapshot'));
        let snapshot = await stub.stepLogMaintenance(app.claims, logId, snapshotId);
        expectSuccess(snapshot);
        expect(snapshot.body.job?.cursor).toBe(16);
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec('UPDATE log_maintenance_jobs SET writes = 10000 WHERE id = ?', snapshotId);
        });
        const paused = await stub.stepLogMaintenance(app.claims, logId, snapshotId);
        expectSuccess(paused);
        expect(paused.body.job?.status).toBe('paused');
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec("UPDATE log_maintenance_jobs SET day = '2000-01-01' WHERE id = ?", snapshotId);
        });
        for (let attempts = 0; snapshot.body.job?.status !== 'complete' && attempts < 40; attempts++) {
            snapshot = await stub.stepLogMaintenance(app.claims, logId, snapshotId);
            expectSuccess(snapshot);
        }
        expect(snapshot.body.job?.status).toBe('complete');
        expect(snapshot.body.checkpoint?.throughVersion).toBe(300);
        expect(snapshot.body.checkpoint!.eventCount).toBeLessThan(10);
        const page = await stub.checkpointChunk(app.claims, logId, 0);
        expectSuccess(page);
        expect(page.body.claims).toEqual([{ entityId: `calendar_event:${recordId}`, currentVersion: 300, logVersion: 300 }]);
        const preview = await stub.compactionPreview(app.claims, logId);
        expectSuccess(preview);
        expect(preview.body.activePayloadEvents).toBe(300);
        expect(preview.body.activePayloadBytes).toBeGreaterThan(preview.body.snapshotBytes);
        const compactId = crypto.randomUUID();
        expect(await stub.startLogMaintenance(app.claims, logId, crypto.randomUUID(), 'compact', snapshotId, 99)).toMatchObject({ ok: false, status: 409, body: { code: 'stale_maintenance_preview' } });
        expectSuccess(await stub.startLogMaintenance(app.claims, logId, compactId, 'compact', snapshotId, 0));
        expectSuccess(await stub.stepLogMaintenance(app.claims, logId, compactId));
        let compacted = await stub.stepLogMaintenance(app.claims, logId, compactId);
        expectSuccess(compacted);
        for (let attempts = 0; compacted.body.job?.status !== 'complete' && attempts < 40; attempts++) {
            compacted = await stub.stepLogMaintenance(app.claims, logId, compactId);
            expectSuccess(compacted);
        }
        expect(compacted.body.compactedThroughVersion).toBe(300);
        expect(await stub.listEvents(app.claims, logId, 0, 512, 2)).toMatchObject({ ok: true, body: { events: accepted.body.events } });
        expect(await stub.appendEvents(app.claims, logId, request, 2)).toEqual(accepted);
        expect(await stub.administratorChecksums(app.appId)).toEqual(before);
        expect((await stub.administratorExportSqlite(app.appId)).status).toBe(409);
        const exported = (await (await stub.administratorTransferExport(app.appId)).text()).trim().split('\n').map(line => JSON.parse(line));
        expect(exported.filter(line => line.t === 'events').flatMap(line => line.events)).toEqual(accepted.body.events);
        await runInDurableObject(stub, (_instance, state) => {
            const row = state.storage.sql.exec<{ payload: string; archive_key: string }>('SELECT payload, archive_key FROM log_events WHERE log_id = ? AND version = 1', logId).one();
            expect(row.payload).toBe('{}');
            expect(row.archive_key).toContain(`/archive/${compactId}/`);
        });
        const fork = await stub.forkLog(app.claims, logId, { name: 'Archived point', targetVersion: 300, expectedSourceHeadVersion: 300, requestId: crypto.randomUUID() });
        expectSuccess(fork);
        expectSuccess(await stub.finalizeFork(app.claims, fork.body.id));
        expect(await stub.listEvents(app.claims, fork.body.id, 0, 512, 2)).toMatchObject({ ok: true, body: { events: accepted.body.events } });
        const archiveKey = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ archive_key: string }>(
            'SELECT archive_key FROM log_events WHERE log_id = ? AND version = 1', logId).one().archive_key);
        const originalObject = await env.LEDGER_ARCHIVE.get(archiveKey);
        const originalText = await originalObject!.text();
        // Even replacing the object's own digest cannot replace the SQL-published checksum.
        await env.LEDGER_ARCHIVE.put(archiveKey, '[]', { customMetadata: { sha256: 'untrusted' } });
        expect(await stub.listEvents(app.claims, logId, 0, 512, 2)).toMatchObject({ ok: false, status: 503,
            body: { code: 'archive_unavailable' } });
        await env.LEDGER_ARCHIVE.put(archiveKey, originalText, { customMetadata: originalObject!.customMetadata });
        expectSuccess(await stub.listEvents(app.claims, logId, 0, 512, 2));
        expect(await stub.deleteLog(app.claims, logId)).toMatchObject({ ok: false, status: 409 });
        expectSuccess(await stub.deleteLog(app.claims, fork.body.id));
        expectSuccess(await stub.deleteLog(app.claims, logId));
        await runInDurableObject(stub, instance => instance.alarm());
        await runInDurableObject(stub, instance => instance.alarm());
        expect((await env.LEDGER_ARCHIVE.list({ prefix: `v1/${app.appId}/${logId}/` })).objects).toHaveLength(0);
    });

    it.skipIf(!fileEvent)('indexes only accepted file versions and copies eligible references into forks', async () => {
        const [addedType, { entity, versionKey }] = fileEvent!;
        const updatedType = addedType.replace(/_ADDED$/, '_UPDATED');
        const application = await provision('gallery-references');
        const stub = env.LEDGER_APP.getByName(application.appId);
        const source = await stub.createLog(application.claims, { name: 'Photos' });
        expectSuccess(source);
        const sourceId = source.body.id;
        const photoId = crypto.randomUUID();
        const fileVersionId = crypto.randomUUID();
        const laterPhotoId = crypto.randomUUID();
        const laterFileVersionId = crypto.randomUUID();
        const photoEvent = (id: string, version: string) => ({
            id: crypto.randomUUID(),
            type: addedType,
            entityId: `${entity}:${id}`,
            payload: { id, [versionKey]: version, filename: 'private.jpg' },
        });

        const malformed = await stub.appendEvents(application.claims, sourceId, {
            requestId: crypto.randomUUID(),
            events: [{ ...photoEvent(photoId, fileVersionId), entityId: `${entity}:${laterPhotoId}` }],
        });
        expect(malformed).toMatchObject({ ok: false, status: 400,
            body: { code: 'invalid_event_envelope' } });
        expectSuccess(await stub.appendEvents(application.claims, sourceId, {
            requestId: crypto.randomUUID(), events: [photoEvent(photoId, fileVersionId)],
        }));
        const firstReference = await stub.getGalleryPhotoReference(
            application.claims, sourceId, photoId, fileVersionId,
        );
        expectSuccess(firstReference);
        expect(firstReference.body).toEqual({ present: true });
        const missingReference = await stub.getGalleryPhotoReference(
            application.claims, sourceId, photoId, laterFileVersionId,
        );
        expectSuccess(missingReference);
        expect(missingReference.body).toEqual({ present: false });

        expectSuccess(await stub.appendEvents(application.claims, sourceId, {
            requestId: crypto.randomUUID(), events: [photoEvent(laterPhotoId, laterFileVersionId)],
        }));
        const fork = await stub.forkLog(application.claims, sourceId, {
            requestId: crypto.randomUUID(), name: 'Before later photo',
            targetVersion: 1, expectedSourceHeadVersion: 2,
        });
        expectSuccess(fork);
        expect(await stub.getGalleryPhotoReference(application.claims, fork.body.id, photoId, fileVersionId))
            .toMatchObject({ ok: false, status: 409, body: { code: 'fork_preparing' } });
        expectSuccess(await stub.finalizeFork(application.claims, fork.body.id));
        const inherited = await stub.getGalleryPhotoReference(
            application.claims, fork.body.id, photoId, fileVersionId,
        );
        expectSuccess(inherited);
        expect(inherited.body.present).toBe(true);
        const excluded = await stub.getGalleryPhotoReference(
            application.claims, fork.body.id, laterPhotoId, laterFileVersionId,
        );
        expectSuccess(excluded);
        expect(excluded.body.present).toBe(false);

        const other = await stub.createLog(application.claims, { name: 'Other' });
        expectSuccess(other);
        const unrelated = await stub.getGalleryPhotoReference(
            application.claims, other.body.id, photoId, fileVersionId,
        );
        expectSuccess(unrelated);
        expect(unrelated.body.present).toBe(false);

        const replacementVersion = crypto.randomUUID();
        expectSuccess(await stub.appendEvents(application.claims, sourceId, {
            requestId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: updatedType,
                entityId: `${entity}:${photoId}`, baseEntityVersion: 1,
                payload: { id: photoId, [versionKey]: replacementVersion } }],
        }));
        const replacement = await stub.getGalleryPhotoReference(
            application.claims, sourceId, photoId, replacementVersion,
        );
        expectSuccess(replacement);
        expect(replacement.body.present).toBe(true);
        const forkReplacement = await stub.getGalleryPhotoReference(
            application.claims, fork.body.id, photoId, replacementVersion,
        );
        expectSuccess(forkReplacement);
        expect(forkReplacement.body.present).toBe(false);
    });

    it("forks a complete accepted prefix without changing the source", async () => {
        const application = await provision("fork-contract");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "Personal" });
        expectSuccess(created);
        const sourceId = created.body.id;
        const first = await stub.appendEvents(application.claims, sourceId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [0, 1].map(index => ({ id: crypto.randomUUID(), type: "BOOK_ADDED",
                entityId: `book:${index}`, payload: { title: `Book ${index}` } })),
        });
        expectSuccess(first);
        const later = await stub.appendEvents(application.claims, sourceId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "BOOK_UPDATED", entityId: "book:0",
                baseEntityVersion: 1, payload: { title: "Later" } }],
        });
        expectSuccess(later);
        const request = { requestId: crypto.randomUUID(), name: "April alternate",
            targetVersion: 2, expectedSourceHeadVersion: 3 };
        await expect(stub.forkLog(application.claims, sourceId, { ...request, targetVersion: 1 }))
            .resolves.toMatchObject({ ok: false, status: 400 });
        const fork = await stub.forkLog(application.claims, sourceId, request);
        expectSuccess(fork);
        expect(fork.body).toMatchObject({ name: "April alternate", headVersion: 2,
            sourceLogId: sourceId, sourceVersion: 2, status: "preparing" });
        const retry = await stub.forkLog(application.claims, sourceId, request);
        expectSuccess(retry);
        expect(retry.body.id).toBe(fork.body.id);
        expect(await stub.listEvents(application.claims, fork.body.id, 0, 512))
            .toMatchObject({ ok: false, status: 409, body: { code: "fork_preparing" } });
        const ready = await stub.finalizeFork(application.claims, fork.body.id);
        expectSuccess(ready);
        expect(ready.body.status).toBe("ready");
        const forkEvents = await stub.listEvents(application.claims, fork.body.id, 0, 512);
        expectSuccess(forkEvents);
        expect(forkEvents.body.events).toEqual(first.body.events);
        const sourceEvents = await stub.listEvents(application.claims, sourceId, 0, 512);
        expectSuccess(sourceEvents);
        expect(sourceEvents.body.events).toEqual([...first.body.events, ...later.body.events]);
        const childEdit = await stub.appendEvents(application.claims, fork.body.id, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "BOOK_UPDATED", entityId: "book:0",
                baseEntityVersion: 1, payload: { title: "Fork edit" } }],
        });
        expectSuccess(childEdit);
        expect(childEdit.body.events[0]).toMatchObject({ version: 3, entityVersion: 2 });
        await expect(stub.deleteLog(application.claims, sourceId))
            .resolves.toMatchObject({ ok: false, status: 409, body: { code: "log_has_forks" } });
        const summary = await env.APP_REGISTRY.getByName("registry-v1").getApplication(application.appId);
        expectSuccess(summary);
        const exported = JSON.parse(await (await stub.administratorExportApplication(summary.body)).text());
        const forkSummary = await stub.getLog(application.claims, fork.body.id);
        expectSuccess(forkSummary);
        expect(forkSummary.body).toMatchObject({ sourceLogId: sourceId, sourceVersion: 2, status: "ready" });
        expect(exported.logs).toContainEqual({
            ...forkSummary.body, events: [...first.body.events, ...childEdit.body.events],
        });
    });

    it("records the gateway-stamped author on accepted events and keeps it across replay and forks", async () => {
        const application = await provision("event-authors");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "authors" });
        expectSuccess(created);
        const logId = created.body.id;
        const event = (label: string) => ({
            id: crypto.randomUUID(), type: "AUTHOR_NOTED", entityId: `note:${label}`,
            payload: { id: label },
        });
        const request = { requestId: crypto.randomUUID(), events: [event("one")] };

        const stamped = await stub.appendEvents(application.claims, logId, request, 0, "  jan@example.com ");
        expectSuccess(stamped);
        expect(stamped.body.events[0]).toMatchObject({ actor: "jan@example.com" });

        // A retry from anyone returns the original author, not the retrier.
        const replayed = await stub.appendEvents(application.claims, logId, request, 0, "other@example.com");
        expect(replayed).toEqual(stamped);

        // A request without an identity, or with a malformed one, stores none.
        const anonymous = await stub.appendEvents(application.claims, logId,
            { requestId: crypto.randomUUID(), events: [event("two")] });
        expectSuccess(anonymous);
        const malformed = await stub.appendEvents(application.claims, logId,
            { requestId: crypto.randomUUID(), events: [event("three")] }, 0, "bad\nvalue");
        expectSuccess(malformed);
        expect("actor" in anonymous.body.events[0]!).toBe(false);
        expect("actor" in malformed.body.events[0]!).toBe(false);

        const listed = await stub.listEvents(application.claims, logId, 0, 10);
        expectSuccess(listed);
        expect(listed.body.events.map(stored => stored.actor)).toEqual(["jan@example.com", undefined, undefined]);

        const fork = await stub.forkLog(application.claims, logId, {
            requestId: crypto.randomUUID(), name: "copy", targetVersion: 1, expectedSourceHeadVersion: 3,
        });
        expectSuccess(fork);
        expectSuccess(await stub.finalizeFork(application.claims, fork.body.id));
        const copied = await stub.listEvents(application.claims, fork.body.id, 0, 10);
        expectSuccess(copied);
        expect(copied.body.events.map(stored => stored.actor)).toEqual(["jan@example.com"]);
    });

    it("hides and shows a log without touching its events or forks", async () => {
        const application = await provision("log-visibility");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "Experiment" });
        expectSuccess(created);
        const logId = created.body.id;
        const appended = await stub.appendEvents(application.claims, logId, {
            requestId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "BOOK_ADDED", entityId: "book:0", payload: { title: "Kept" } }],
        });
        expectSuccess(appended);

        const hidden = await stub.setLogVisibility(application.claims, logId, { hidden: true });
        expectSuccess(hidden);
        expect(hidden.body).toMatchObject({ id: logId, headVersion: 1, hiddenAt: expect.any(String) });
        const again = await stub.setLogVisibility(application.claims, logId, { hidden: true });
        expectSuccess(again);
        expect(again.body.hiddenAt).toBe(hidden.body.hiddenAt);
        const listed = await stub.listLogs(application.claims);
        expectSuccess(listed);
        expect(listed.body.logs.find(log => log.id === logId)?.hiddenAt).toBe(hidden.body.hiddenAt);
        const events = await stub.listEvents(application.claims, logId, 0, 512);
        expectSuccess(events);
        expect(events.body.events).toEqual(appended.body.events);

        const shown = await stub.setLogVisibility(application.claims, logId, { hidden: false });
        expectSuccess(shown);
        expect(shown.body.hiddenAt).toBeNull();
        await expect(stub.setLogVisibility(application.claims, logId, { hidden: "yes" } as never))
            .resolves.toMatchObject({ ok: false, status: 400 });
        await expect(stub.setLogVisibility(application.claims, crypto.randomUUID(), { hidden: true }))
            .resolves.toMatchObject({ ok: false, status: 404 });
    });

    it("rejects appends that can never be stored as client errors", async () => {
        const application = await provision("append-limits");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "limits" });
        expectSuccess(created);
        const logId = created.body.id;
        const event = (entityId: string, extra: Record<string, unknown> = {}) => ({
            id: crypto.randomUUID(), type: "BOOK_ADDED", entityId, payload: {}, ...extra,
        });
        const append = (events: ReturnType<typeof event>[]) =>
            stub.appendEvents(application.claims, logId, { requestId: crypto.randomUUID(), events });

        const accepted = event("book:accepted");
        expectSuccess(await append([accepted]));
        await expect(append([{ ...accepted, entityId: "book:copy" }])).resolves.toMatchObject({
            ok: false, status: 409, body: { code: "event_already_accepted", eventId: accepted.id },
        });
        const repeated = event("book:repeated");
        await expect(append([repeated, { ...repeated, entityId: "book:other" }])).resolves.toMatchObject({
            ok: false, status: 400, body: { code: "invalid_event_envelope" },
        });
        await expect(append([event("book:future", { timestamp: 9e15 })])).resolves.toMatchObject({
            ok: false, status: 400, body: { code: "invalid_event_envelope" },
        });
        const blob = "x".repeat(600_000);
        await expect(append([0, 1, 2, 3].map(index => event(`book:large-${index}`, { payload: { blob } }))))
            .resolves.toMatchObject({ ok: false, status: 400, body: { code: "request_too_large" } });
        await expect(append(Array.from({ length: 513 }, (_, index) => event(`book:many-${index}`))))
            .resolves.toMatchObject({ ok: false, status: 400, body: { code: "validation_error" } });

        const log = await stub.getLog(application.claims, logId);
        expectSuccess(log);
        expect(log.body.headVersion).toBe(1);
    });

    it("applies replay and fork gates to every log id spelling and socket", async () => {
        const application = await provision("replay-gates");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "gates" });
        expectSuccess(created);
        const logId = created.body.id;
        expectSuccess(await stub.appendEvents(application.claims, logId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "BOOK_ADDED", entityId: "book:0", payload: {} }],
        }, 2));
        expectSuccess(await stub.appendEvents(application.claims, logId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "EVENTS_EXCISED", entityId: "excision:1",
                payload: { eventIds: ["removed"] } }],
        }, 2));
        await expect(stub.listEvents(application.claims, logId.toUpperCase(), 0, 512, 1))
            .resolves.toMatchObject({ ok: false, status: 409, body: { code: "client_upgrade_required" } });

        const fork = await stub.forkLog(application.claims, logId, {
            requestId: crypto.randomUUID(), name: "preparing", targetVersion: 1, expectedSourceHeadVersion: 2,
        });
        expectSuccess(fork);
        const socket = (id: string, headers: Record<string, string>) => stub.fetch(new Request(
            `https://ledger/logs/${id}/events/socket?replayVersion=2`,
            { headers: { "Sec-WebSocket-Protocol": "ledger.v1",
                "x-ledger-internal-access": JSON.stringify(application.claims), ...headers } },
        ));
        const preparing = await socket(fork.body.id, { Upgrade: "websocket" });
        expect(preparing.status).toBe(409);
        expect(await preparing.json()).toMatchObject({ code: "fork_preparing" });
        const plain = await socket(logId, {});
        expect(plain.status).toBe(426);
        expect(await plain.json()).toMatchObject({ code: "upgrade_required" });
    });

    it("checks replay compatibility without reading the whole log", async () => {
        const application = await provision("replay-index");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "large" });
        expectSuccess(created);
        for (let batch = 0; batch < 20; batch++) {
            expectSuccess(await stub.appendEvents(application.claims, created.body.id, {
                requestId: crypto.randomUUID(),
                events: Array.from({ length: 100 }, (_, index) => ({
                    type: "BOOK_ADDED", entityId: `book:${batch}:${index}`, payload: {},
                })),
            }, 2));
        }
        const rowsRead = await runInDurableObject(stub, async (instance, state) => {
            const sql = state.storage.sql;
            const exec = sql.exec.bind(sql);
            const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
            sql.exec = ((query: string, ...bindings: unknown[]) => {
                const cursor = exec(query, ...bindings);
                cursors.push(cursor);
                return cursor;
            }) as typeof sql.exec;
            try {
                expectSuccess(await instance.listEvents(application.claims, created.body.id, 0, 1, 2));
            } finally {
                sql.exec = exec;
            }
            return cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
        });
        expect(rowsRead).toBeLessThan(50);
    });

    it("keeps a committed append successful when realtime delivery fails", async () => {
        const application = await provision("delivery-failure");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "delivery" });
        expectSuccess(created);
        const result = await runInDurableObject(stub, async (instance) => {
            const target = instance as unknown as { deliver(logId: string): void };
            target.deliver = () => {
                throw new TypeError("socket already closed");
            };
            return instance.appendEvents(application.claims, created.body.id, {
                requestId: crypto.randomUUID(),
                events: [{ type: "BOOK_ADDED", entityId: "book:delivered", payload: {} }],
            });
        });
        expect(result).toMatchObject({ ok: true, body: { newVersion: 1 } });
    });

    it("keeps a bounded history of disconnected sockets for administrators", async () => {
        const application = await provision("socket-sessions");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "sessions" });
        expectSuccess(created);
        const connect = async () => {
            const response = await stub.fetch(new Request(
                `https://ledger/logs/${created.body.id}/events/socket?replayVersion=2`,
                { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "ledger.v1",
                    "User-Agent": "Session history test", "x-ledger-internal-access": JSON.stringify(application.claims) } },
            ));
            expect(response.status).toBe(101);
            response.webSocket!.accept();
            return response.webSocket!;
        };
        const connections = async () => {
            const result = await stub.administratorConnections(application.appId, {});
            expectSuccess(result);
            return result.body;
        };

        const socket = await connect();
        const live = await connections();
        expect(live.connections).toHaveLength(1);
        expect(live.recent).toEqual([]);
        socket.close(1000, "client shutdown");
        const [connection] = live.connections;
        await expect.poll(async () => (await connections()).recent).toMatchObject([{
            id: connection!.id, logName: "sessions", closeCode: 1000,
            connectedAt: connection!.connectedAt,
            client: { userAgent: "Session history test" },
        }]);
        const closed = await connections();
        expect(closed.total).toBe(0);
        expect(closed.recent[0]!.disconnectedAt).not.toBeNull();

        const sockets = [];
        for (let index = 0; index < 50; index++) sockets.push(await connect());
        const rows = await runInDurableObject(stub, (_instance, state) =>
            state.storage.sql.exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM socket_sessions",
            ).one().count);
        expect(rows).toBe(50);
        expect((await connections()).recent).toEqual([]);
        for (const item of sockets) item.close(1000, "client shutdown");
    });

    it('restores verified fork lineage after a logical event import', async () => {
        const application = await provision('fork-lineage-restore');
        const stub = env.LEDGER_APP.getByName(application.appId);
        const parent = await stub.createLog(application.claims, { name: 'parent' });
        const child = await stub.createLog(application.claims, { name: 'child' });
        expectSuccess(parent);
        expectSuccess(child);
        const event = { id: crypto.randomUUID(), type: 'BOOK_ADDED', entityId: 'book:one', payload: { title: 'Same prefix' } };
        expectSuccess(await stub.appendEvents(application.claims, parent.body.id,
            { requestId: crypto.randomUUID(), events: [event] }));
        expectSuccess(await stub.appendEvents(application.claims, child.body.id,
            { requestId: crypto.randomUUID(), events: [event] }));
        const lineage = await stub.administratorSetLogLineage(application.appId, child.body.id,
            { sourceLogId: parent.body.id, sourceVersion: 1 });
        expectSuccess(lineage);
        expect(lineage.body).toMatchObject({ sourceLogId: parent.body.id, sourceVersion: 1,
            sourceLogName: 'parent' });
        expectSuccess(await stub.administratorSetLogLineage(application.appId, child.body.id,
            { sourceLogId: parent.body.id, sourceVersion: 1 }));
        const other = await stub.createLog(application.claims, { name: 'different' });
        expectSuccess(other);
        expectSuccess(await stub.appendEvents(application.claims, other.body.id, {
            requestId: crypto.randomUUID(), events: [{ ...event, id: crypto.randomUUID() }],
        }));
        await expect(stub.administratorSetLogLineage(application.appId, other.body.id,
            { sourceLogId: parent.body.id, sourceVersion: 1 }))
            .resolves.toMatchObject({ ok: false, status: 400 });
    });

    it("atomically checks restore boundaries, replays lost responses and gates old clients", async () => {
        const application = await provision("restore-contract");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "restore" });
        expectSuccess(created);
        const logId = created.body.id;
        expectSuccess(await stub.appendEvents(application.claims, logId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [0, 1].map(index => ({ id: crypto.randomUUID(), type: "BOOK_ADDED", entityId: `book:${index}`, payload: {} })),
        }));
        const request = { requestId: crypto.randomUUID(), actionId: crypto.randomUUID(), expectedLogVersion: 2,
            events: [{ id: crypto.randomUUID(), type: "WORKSPACE_RESTORED", entityId: "workspace:state", timestamp: 1,
                payload: { targetVersion: 1 } }] };
        await expect(stub.appendEvents(application.claims, logId, request, 1)).resolves.toMatchObject({ ok: false, status: 400 });
        request.events[0]!.payload.targetVersion = 0;
        const restored = await stub.appendEvents(application.claims, logId, request, 1);
        expectSuccess(restored); expect(restored.body.newVersion).toBe(3);
        const replay = await stub.appendEvents(application.claims, logId, request, 1);
        expectSuccess(replay); expect(replay.body).toEqual(restored.body);
        await expect(stub.appendEvents(application.claims, logId, { ...request, requestId: crypto.randomUUID() }, 1))
            .resolves.toMatchObject({ ok: false, status: 409, body: { code: "stale_restore_preview" } });
        await expect(stub.listEvents(application.claims, logId, 0, 512))
            .resolves.toMatchObject({ ok: false, status: 409, body: { code: "client_upgrade_required" } });
        const page = await stub.listEvents(application.claims, logId, 0, 512, 1);
        expectSuccess(page); expect(page.body.events).toHaveLength(3);
        const lateUpload = { requestId: crypto.randomUUID(), events: [{ id: crypto.randomUUID(), type: "BOOK_UPDATED",
            entityId: "book:0", baseEntityVersion: 1, timestamp: 0, payload: { title: "Queued before restore" } }] };
        await expect(stub.appendEvents(application.claims, logId, lateUpload))
            .resolves.toMatchObject({ ok: false, status: 409, body: { code: "client_upgrade_required" } });
        const later = await stub.appendEvents(application.claims, logId, lateUpload, 1);
        expectSuccess(later); expect(later.body.newVersion).toBe(4);
        const oldSocket = await stub.fetch(new Request(`https://ledger/logs/${logId}/events/socket`, { headers: {
            Upgrade: "websocket", "Sec-WebSocket-Protocol": "ledger.v1", "x-ledger-internal-access": JSON.stringify(application.claims),
        } }));
        expect(oldSocket.status).toBe(409);
        expect(await oldSocket.json()).toMatchObject({ code: "client_upgrade_required" });

        // Exercise the logical-backup request builder against a separate tenant.
        // Reading one event per page deliberately splits the original action.
        const destination = await provision("restore-roundtrip");
        const target = env.LEDGER_APP.getByName(destination.appId);
        const targetLog = await target.createLog(destination.claims, { name: "restored" });
        expectSuccess(targetLog);
        const exported = [];
        for (let after = 0; after < 4; after++) {
            const part = await stub.listEvents(application.claims, logId, after, 1, 1);
            expectSuccess(part); exported.push(...part.body.events);
        }
        for (const batch of actionBatches(JSON.parse(JSON.stringify(exported)))) {
            expectSuccess(await target.appendEvents(destination.claims, targetLog.body.id,
                restoreBatchRequest(batch, crypto.randomUUID()), 1));
        }
        const imported = await target.listEvents(destination.claims, targetLog.body.id, 0, 512, 1);
        expectSuccess(imported);
        expect(imported.body.events).toEqual(exported);
    });

    it("gates and validates event excision by replay version", async () => {
        const application = await provision("excision-contract");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "excision" });
        expectSuccess(created);
        const logId = created.body.id;
        expectSuccess(await stub.appendEvents(application.claims, logId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [{ id: crypto.randomUUID(), type: "BOOK_ADDED", entityId: "book:0", payload: {} }],
        }, 2));
        const marker = { id: crypto.randomUUID(), type: "EVENTS_EXCISED", entityId: `excision:${crypto.randomUUID()}`,
            timestamp: 1, payload: { eventIds: ["event-1"], note: "duplicate import" } };
        await expect(stub.appendEvents(application.claims, logId, { requestId: crypto.randomUUID(), events: [marker] }, 1))
            .resolves.toMatchObject({ ok: false, status: 400 });
        const malformed = await stub.appendEvents(application.claims, logId, { requestId: crypto.randomUUID(),
            events: [{ ...marker, id: crypto.randomUUID(), payload: { eventIds: ["a", "a"] } }] }, 2);
        expect(malformed).toMatchObject({ ok: false, status: 400 });
        const empty = await stub.appendEvents(application.claims, logId, { requestId: crypto.randomUUID(),
            events: [{ ...marker, id: crypto.randomUUID(), payload: { eventIds: [] } }] }, 2);
        expect(empty).toMatchObject({ ok: false, status: 400 });
        expectSuccess(await stub.appendEvents(application.claims, logId, {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(), events: [marker],
        }, 2));
        await expect(stub.listEvents(application.claims, logId, 0, 512))
            .resolves.toMatchObject({ ok: false, status: 409, body: { code: "client_upgrade_required" } });
        const page = await stub.listEvents(application.claims, logId, 0, 512, 2);
        expectSuccess(page);
        expect(page.body.events.map(event => event.type)).toEqual(["BOOK_ADDED", "EVENTS_EXCISED"]);
        const session = await stub.getSession(application.claims);
        expectSuccess(session);
        expect(session.body.capabilities).toContain("event-excision-v1");
    });

    it("preserves complete action identity in replay, paging and export", async () => {
        const application = await provision("action-contract");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "actions" });
        expectSuccess(created);
        const request = {
            requestId: crypto.randomUUID(), actionId: crypto.randomUUID(),
            events: [0, 1].map(index => ({ id: crypto.randomUUID(), type: "BOOK_ADDED",
                entityId: `book:${index}`, payload: { title: `Book ${index}` } })),
        };
        const accepted = await stub.appendEvents(application.claims, created.body.id, request);
        expectSuccess(accepted);
        expect(accepted.body.events.map(event => event.action)).toEqual([
            { id: request.actionId, index: 0, size: 2 }, { id: request.actionId, index: 1, size: 2 },
        ]);
        const replay = await stub.appendEvents(application.claims, created.body.id, request);
        expectSuccess(replay); expect(replay.body).toEqual(accepted.body);
        const page = await stub.listEvents(application.claims, created.body.id, 1, 1);
        expectSuccess(page); expect(page.body.events).toEqual([accepted.body.events[1]]);
        const changedIdentity = await stub.appendEvents(application.claims, created.body.id,
            { ...request, actionId: crypto.randomUUID() });
        expect(changedIdentity).toMatchObject({ ok: false, status: 409 });
        const duplicateAction = await stub.appendEvents(application.claims, created.body.id,
            { ...request, requestId: crypto.randomUUID() });
        expect(duplicateAction).toMatchObject({ ok: false, status: 409 });
        const dump = await (await stub.administratorExportSqlite(application.appId)).text();
        expect(dump).toContain([...new TextEncoder().encode(request.actionId)]
            .map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase());
        const admin = await stub.administratorListEvents(application.appId, created.body.id, {});
        expectSuccess(admin);
        expect(admin.body.events[0]?.action).toEqual(accepted.body.events[1]?.action);
    });

    it("exports full SQLite tables and rejects writes during streaming", async () => {
        const application = await provision("sqlite-export");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const dump = await (await stub.administratorExportSqlite(application.appId)).text();
        expect(dump).toContain("CREATE TABLE append_requests");
        expect(dump).toContain("CREATE TABLE app_metadata");
        expect(dump).toContain("CREATE TABLE _sql_schema_migrations");
        expect(dump).toContain(SQL_EXPORT_COMPLETE);
        const changed = await runInDurableObject(stub, async (_instance, state) => {
            const response = sqliteExport(state.storage, "test");
            const reader = response.body!.getReader();
            await reader.read();
            state.storage.sql.exec("UPDATE app_metadata SET name = 'changed' WHERE singleton = 1");
            try { while (!(await reader.read()).done) { /* drain */ } return false; }
            catch { return true; }
        });
        expect(changed).toBe(true);
    });
    it("matches the language-neutral append-hash fixture", async () => {
        const request = decodeRpc(
            appendEventsBody,
            appendHashFixture.request,
            "append-hash fixture",
        );
        await expect(
            hashAppendRequest(appendHashFixture.logId, request),
        ).resolves.toBe(appendHashFixture.expectedHash);
    });

    it("preserves session, append, paging, and idempotency contracts", async () => {
        const application = await provision("rpc-contract");
        const stub = env.LEDGER_APP.getByName(application.appId);

        const session = await stub.getSession(application.claims);
        expectSuccess(session);
        expect(session.body).toEqual({
            appId: application.appId,
            principalId: application.claims.principalId,
            capabilities: ["snapshot-baseline-v1", "action-metadata-v1", "workspace-restore-v1", "event-excision-v1"],
        });

        const createdLog = await stub.createLog(application.claims, {
            name: "contract",
        });
        expectSuccess(createdLog);
        expect(createdLog.status).toBe(201);
        const logId = createdLog.body.id;

        const requestId = crypto.randomUUID();
        const entityId = `contract:${crypto.randomUUID()}`;
        const event = {
            id: crypto.randomUUID(),
            type: "CONTRACT_CREATED",
            entityId,
            payload: { nested: { valid: true }, value: 1 },
        };

        const first = await stub.appendEvents(application.claims, logId, {
            requestId,
            events: [event],
        });
        expectSuccess(first);
        const firstBody = first.body;
        expect(firstBody).toMatchObject({
            newVersion: 1,
            events: [{ version: 1, entityVersion: 1 }],
        });

        const replay = await stub.appendEvents(application.claims, logId, {
            requestId,
            events: [event],
        });
        expectSuccess(replay);
        expect(replay.body).toEqual(firstBody);

        const page = await stub.listEvents(application.claims, logId, 0, 512);
        expectSuccess(page);
        expect(page.body).toMatchObject({
            events: [{ version: 1, entityVersion: 1 }],
        });

        const mismatch = await stub.appendEvents(application.claims, logId, {
            requestId,
            events: [{ ...event, payload: { value: 2 } }],
        });
        expect(mismatch).toMatchObject({
            ok: false,
            status: 409,
            body: { code: "idempotency_mismatch" },
        });

        const logs = await stub.listLogs(application.claims);
        expectSuccess(logs);
        expect(logs.body.logs).toHaveLength(1);

        const deleted = await stub.deleteLog(application.claims, logId);
        expectSuccess(deleted);
        expect(deleted).toMatchObject({ status: 204, body: null });
    });

    it("returns serializable known failures and propagates unexpected failures", async () => {
        const application = await provision("rpc-errors");
        const stub = env.LEDGER_APP.getByName(application.appId);

        await expect(
            stub.getLog(application.claims, "not-a-uuid"),
        ).resolves.toMatchObject({
            ok: false,
            status: 400,
            body: { code: "validation_error" },
        });

        await expect(
            env.LEDGER_APP.getByName(crypto.randomUUID()).initializeApplication(
                {
                    appId: "not-an-app-uuid",
                    name: "invalid",
                    principalId: crypto.randomUUID(),
                    generation: 1,
                    createdAt: new Date().toISOString(),
                },
            ),
        ).resolves.toMatchObject({
            ok: false,
            status: 400,
            body: { code: "validation_error" },
        });

        await expect(
            rpcCall(() => {
                throw new Error("unexpected storage failure");
            }),
        ).rejects.toThrow("unexpected storage failure");
        await expect(
            rpcCall(() => {
                throw new TypeError("server bug");
            }),
        ).rejects.toThrow("server bug");

        const registry = env.APP_REGISTRY.getByName("duplicate-contract");
        const name = `duplicate-${crypto.randomUUID()}`;
        expectSuccess(await registry.createApplication({ name }));
        await expect(
            registry.createApplication({ name }),
        ).resolves.toMatchObject({
            ok: false,
            status: 409,
            body: { code: "app_name_conflict" },
        });

        const damagedRegistry = env.APP_REGISTRY.getByName(
            "unexpected-storage-failure",
        );
        const storageFailure = await runInDurableObject(
            damagedRegistry,
            async (instance, state) => {
                state.storage.sql.exec("DROP TABLE applications");
                try {
                    await instance.createApplication({
                        name: `storage-${crypto.randomUUID()}`,
                    });
                    return null;
                } catch (cause) {
                    return cause instanceof Error
                        ? cause.message
                        : String(cause);
                }
            },
        );
        expect(storageFailure).toContain("no such table");
    });

    it("rejects stale credentials after rotation and revocation", async () => {
        const application = await provision("rpc-credentials");
        const registry = env.APP_REGISTRY.getByName("registry-v1");
        const stub = env.LEDGER_APP.getByName(application.appId);

        const rotated = await registry.rotateApplicationToken(
            application.appId,
        );
        expectSuccess(rotated);
        const rotatedClaims = await verifyAccess(env, rotated.body.token);

        await expect(stub.listLogs(application.claims)).resolves.toMatchObject({
            ok: false,
            status: 401,
            body: { code: "unauthorized" },
        });
        expectSuccess(await stub.listLogs(rotatedClaims));

        const revoked = await registry.revokeApplication(application.appId);
        expectSuccess(revoked);
        expect(revoked.body.revokedAt).not.toBeNull();

        await expect(stub.listLogs(rotatedClaims)).resolves.toMatchObject({
            ok: false,
            status: 401,
            body: { code: "unauthorized" },
        });
    });

    it("releases a failed provisioning name and never rotates backwards", async () => {
        const registry = env.APP_REGISTRY.getByName("provisioning-failure");
        const name = `flaky-${crypto.randomUUID()}`;
        const failed = await runInDurableObject(registry, async (instance) => {
            const target = instance as unknown as { env: Env };
            const original = target.env;
            target.env = { ...original, LEDGER_APP: { getByName: () => ({
                initializeApplication: async () => { throw new Error("ledger unavailable"); },
            }) } } as unknown as Env;
            try {
                return await instance.createApplication({ name });
            } finally {
                target.env = original;
            }
        });
        expect(failed).toMatchObject({ ok: false, status: 500, body: { code: "provisioning_failed" } });
        const created = await registry.createApplication({ name });
        expectSuccess(created);

        const stub = env.LEDGER_APP.getByName(created.body.app.id);
        await expect(stub.rotateApplicationPrincipal({
            principalId: crypto.randomUUID(), generation: 1, createdAt: new Date().toISOString(),
        })).resolves.toMatchObject({ ok: false, status: 409, body: { code: "rotation_superseded" } });
        await expect(stub.getSession(await verifyAccess(env, created.body.token)))
            .resolves.toMatchObject({ ok: true });

        const lostRotation = await runInDurableObject(registry, async (instance) => {
            const target = instance as unknown as { env: Env };
            const original = target.env;
            target.env = { ...original, LEDGER_APP: { getByName: () => ({
                rotateApplicationPrincipal: async () => { throw new Error("ledger unavailable"); },
            }) } } as unknown as Env;
            try {
                return await instance.rotateApplicationToken(created.body.app.id).catch(() => null);
            } finally {
                target.env = original;
            }
        });
        expect(lostRotation).toBeNull();
        const rotated = await registry.rotateApplicationToken(created.body.app.id);
        expectSuccess(rotated);
        const rotatedClaims = await verifyAccess(env, rotated.body.token);
        expect(rotatedClaims.generation).toBe(3);
        await expect(stub.getSession(rotatedClaims)).resolves.toMatchObject({ ok: true });
    });

    it("lets administrators inspect logs and stream a complete revoked-app export", async () => {
        const application = await provision("rpc-admin-export");
        const registry = env.APP_REGISTRY.getByName("registry-v1");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const createdLog = await stub.createLog(application.claims, {
            name: "exported-log",
        });
        expectSuccess(createdLog);
        const appended = await stub.appendEvents(
            application.claims,
            createdLog.body.id,
            {
                requestId: crypto.randomUUID(),
                events: [
                    {
                        id: crypto.randomUUID(),
                        type: "ADMIN_EXPORT_TEST",
                        entityId: "export:one",
                        timestamp: 1_800_000_000_000,
                        payload: { complete: true },
                    },
                ],
            },
        );
        expectSuccess(appended);

        const revoked = await registry.revokeApplication(application.appId);
        expectSuccess(revoked);
        const logs = await stub.administratorListLogs(application.appId);
        expectSuccess(logs);
        expect(logs.body.logs).toEqual([
            expect.objectContaining({
                id: createdLog.body.id,
                name: "exported-log",
                headVersion: 1,
                createdAt: expect.any(String),
            }),
        ]);

        const summary = await registry.getApplication(application.appId);
        expectSuccess(summary);
        const response = await stub.administratorExportApplication(
            summary.body,
        );
        expect(response.headers.get("content-disposition")).toMatch(
            /^attachment; filename="ledger-rpc-admin-export-/,
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        const exportJson = await response.text();
        expect(exportJson).not.toContain(application.token);
        expect(JSON.parse(exportJson)).toMatchObject({
            format: "ledger-application-export",
            version: 1,
            application: {
                id: application.appId,
                revokedAt: expect.any(String),
            },
            logs: [
                {
                    id: createdLog.body.id,
                    name: "exported-log",
                    headVersion: 1,
                    events: [
                        {
                            type: "ADMIN_EXPORT_TEST",
                            entityId: "export:one",
                            payload: { complete: true },
                        },
                    ],
                },
            ],
        });
    });

    it("pages and searches all admin events, remains readable after revocation, and isolates applications", async () => {
        const application = await provision("rpc-admin-events");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const created = await stub.createLog(application.claims, { name: "history" });
        expectSuccess(created);
        const appended = await stub.appendEvents(application.claims, created.body.id, {
            requestId: crypto.randomUUID(),
            events: Array.from({ length: 105 }, (_, index) => ({
                type: index === 0 ? "OLDEST_MATCH" : "ITEM_CREATED", entityId: `entity:${index}`,
                payload: { index },
            })),
        });
        expectSuccess(appended);
        const metrics = await stub.administratorMetrics(application.appId);
        expectSuccess(metrics);
        expect(metrics.body).toMatchObject({ logCount: 1, eventCount: 105, entityCount: 105, connectedClients: 0 });
        expect(metrics.body.databaseBytes).toBeGreaterThan(0);
        expect(metrics.body.lastUpdatedAt).not.toBeNull();
        const first = await stub.administratorListEvents(application.appId, created.body.id, {});
        expectSuccess(first);
        expect(first.body.events).toHaveLength(50);
        expect(first.body.events[0]?.version).toBe(105);
        expect(first.body.nextBeforeVersion).toBe(56);
        const second = await stub.administratorListEvents(application.appId, created.body.id, { beforeVersion: 56 });
        expectSuccess(second);
        expect(second.body.events[0]?.version).toBe(55);
        expect(second.body.nextBeforeVersion).toBe(6);
        const last = await stub.administratorListEvents(application.appId, created.body.id, { beforeVersion: 6 });
        expectSuccess(last);
        expect(last.body.events.map(event => event.version)).toEqual([5, 4, 3, 2, 1]);
        expect(last.body.nextBeforeVersion).toBeNull();
        const revoked = await env.APP_REGISTRY.getByName("registry-v1").revokeApplication(application.appId);
        expectSuccess(revoked);
        const search = await stub.administratorListEvents(application.appId, created.body.id, { search: "oldest_match" });
        expectSuccess(search);
        expect(search.body.events.map(event => event.version)).toEqual([1]);
        const injection = await stub.administratorListEvents(application.appId, created.body.id, { search: "' OR 1=1 --" });
        expectSuccess(injection);
        expect(injection.body.events).toEqual([]);
        await expect(stub.administratorListEvents(crypto.randomUUID(), created.body.id, {})).resolves.toMatchObject({ ok: false, status: 404 });
        await expect(stub.administratorListEvents(application.appId, crypto.randomUUID(), {})).resolves.toMatchObject({ ok: false, status: 404 });
        await expect(stub.administratorListEvents(application.appId, created.body.id, { limit: 101 })).resolves.toMatchObject({ ok: false, status: 400 });
    });

    it("validates persisted idempotency responses before replay", async () => {
        const application = await provision("rpc-idempotency-storage");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const createdLog = await stub.createLog(application.claims, {
            name: "idempotency-storage",
        });
        expectSuccess(createdLog);

        const requestId = crypto.randomUUID();
        const request = {
            requestId,
            events: [
                {
                    type: "IDEMPOTENCY_STORED",
                    entityId: `stored:${crypto.randomUUID()}`,
                    payload: { valid: true },
                },
            ],
        };
        const accepted = await stub.appendEvents(
            application.claims,
            createdLog.body.id,
            request,
        );
        expectSuccess(accepted);

        const replay = (update: string, ...bindings: SqlStorageValue[]) => runInDurableObject(
            stub,
            async (instance, state) => {
                state.storage.sql.exec(update, ...bindings, requestId, createdLog.body.id);
                try {
                    return await instance.appendEvents(
                        application.claims,
                        createdLog.body.id,
                        request,
                    );
                } catch (cause) {
                    return cause instanceof Error
                        ? cause.message
                        : String(cause);
                }
            },
        );

        // A replay is rebuilt from the accepted events, not the stored copy.
        const fromRange = await replay(
            `UPDATE append_requests SET result = ? WHERE request_id = ? AND log_id = ?`,
            "not json",
        );
        expect(fromRange).toEqual(accepted);

        const beyondHead = await replay(
            `UPDATE append_requests SET last_version = ? WHERE request_id = ? AND log_id = ?`,
            99,
        );
        expect(beyondHead).toBe("invalid persisted idempotency response");

        // Rows written before the range columns still replay their stored copy.
        const legacy = await replay(
            `UPDATE append_requests SET first_version = NULL, last_version = NULL, result = ?
             WHERE request_id = ? AND log_id = ?`,
            '{"newVersion":"invalid","events":[]}',
        );
        expect(legacy).toBe("invalid persisted idempotency response");
    });

    it("drops obsolete socket-ticket storage", async () => {
        const application = await provision("rpc-schema");
        const stub = env.LEDGER_APP.getByName(application.appId);
        const obsoleteObjects = await runInDurableObject(
            stub,
            async (_instance, state) =>
                state.storage.sql
                    .exec<{ name: string }>(
                        `SELECT name FROM sqlite_master
                         WHERE name IN ('socket_tickets', 'log_events_entity_idx')
                         ORDER BY name`,
                    )
                    .toArray(),
        );
        expect(obsoleteObjects).toEqual([]);
    });
});

async function provision(label: string): Promise<ProvisionedApplication> {
    const result = await env.APP_REGISTRY.getByName(
        "registry-v1",
    ).createApplication({
        name: `${label}-${crypto.randomUUID()}`,
        // These tests append arbitrary event types; the policy tests cover the strict default.
        policy: { contracts: null, dynamicEvents: true, validation: null },
    });
    expectSuccess(result);
    return {
        appId: result.body.app.id,
        claims: await verifyAccess(env, result.body.token),
        token: result.body.token,
    };
}

function expectSuccess<T>(
    result: RpcResult<T>,
): asserts result is RpcSuccess<T> {
    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(
            `expected RPC success, received ${result.status}: ${JSON.stringify(result.body)}`,
        );
    }
}
