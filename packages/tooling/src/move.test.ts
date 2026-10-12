import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveApplication, MoveError, sameChecksums, type AdminCall, type LogChecksum } from './index.js';

const APP = '11111111-1111-4111-8111-111111111111';
const LOG = '22222222-2222-4222-8222-222222222222';
const checksum: LogChecksum = { id: LOG, headVersion: 3, eventCount: 3, sha256: 'a'.repeat(64) };

const stream = [
    { t: 'app', id: APP, name: 'st-production', createdAt: '2026-01-01T00:00:00.000Z', policy: null },
    { t: 'log', id: LOG, name: 'main', createdAt: '2026-01-01T00:00:00.000Z', lastUpdatedAt: null, sourceLogId: null, sourceVersion: null, hiddenAt: null, headVersion: 3 },
    { t: 'events', logId: LOG, events: [{ version: 1 }, { version: 2 }, { version: 3 }] },
    { t: 'requests', logId: LOG, requests: [{ requestId: 'r' }] },
    { t: 'end', logs: 1, events: 3, requests: 1 },
];
const ndjson = (lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

function fakes(options: { fence?: string | null; lines?: unknown[]; targetChecksum?: LogChecksum; failChunk?: boolean } = {}) {
    const calls: string[] = [];
    const posted: unknown[] = [];
    const source: AdminCall = async (method, path) => {
        calls.push(`source ${method} ${path}`);
        if (path.endsWith('/fence')) return Response.json({ fence: options.fence === null ? null : { mode: options.fence ?? 'tenant_migrating', destination: null } });
        if (path.endsWith('/transfer')) return new Response(ndjson(options.lines ?? stream));
        if (path.endsWith('/checksums')) return Response.json({ logs: [checksum] });
        throw new Error(`unexpected ${method} ${path}`);
    };
    const target: AdminCall = async (method, path, body) => {
        calls.push(`target ${method} ${path}`);
        posted.push(body);
        if (path.endsWith('/import') && options.failChunk) return new Response('boom', { status: 500 });
        if (path.endsWith('/checksums')) return Response.json({ logs: [options.targetChecksum ?? checksum] });
        return Response.json({ ok: true });
    };
    return { calls, posted, source, target };
}

test('moves a fenced application in order, finishes with the heads the source reported, and verifies checksums', async () => {
    const { calls, posted, source, target } = fakes();
    const report = await moveApplication({ appId: APP, source, target, now: () => new Date('2026-10-08T00:00:00Z') });
    assert.deepEqual(report, { appId: APP, name: 'st-production', logs: 1, events: 3, requests: 1, checksums: [checksum], movedAt: '2026-10-08T00:00:00.000Z' });
    assert.deepEqual(calls.filter((call) => call.startsWith('target')).slice(0, 4), [
        `target POST /admin/v1/apps/${APP}/import/abort`,
        'target POST /admin/v1/import', `target POST /admin/v1/apps/${APP}/import`, `target POST /admin/v1/apps/${APP}/import/finish`,
    ]);
    assert.deepEqual(posted[3], { logs: [{ id: LOG, headVersion: 3 }] });
    // The only abort is the one that clears a leftover; a successful move does not abort again.
    assert.equal(calls.filter((call) => call.includes('abort')).length, 1);
});

test('batches records and never sends the app or end lines as records', async () => {
    const { posted, source, target } = fakes();
    await moveApplication({ appId: APP, source, target, maxBatchRecords: 2 });
    const chunks = posted.filter((body) => (body as { records?: unknown[] } | undefined)?.records).map((body) => (body as { records: Array<{ t: string }> }).records.map((record) => record.t));
    assert.deepEqual(chunks, [['log', 'events'], ['requests']]);
});

test('refuses an unfenced source, and a rehearsal may opt out', async () => {
    const unfenced = fakes({ fence: null });
    await assert.rejects(moveApplication({ appId: APP, source: unfenced.source, target: unfenced.target }), /not fenced/);
    assert.deepEqual(unfenced.calls.filter((call) => call.startsWith('target')), []);
    const moved = fakes({ fence: 'moved' });
    await assert.rejects(moveApplication({ appId: APP, source: moved.source, target: moved.target }), /not fenced/);
    const rehearsal = fakes({ fence: null });
    await moveApplication({ appId: APP, source: rehearsal.source, target: rehearsal.target, allowUnfenced: true });
});

test('aborts the half-filled destination when the export is cut short or the totals disagree', async () => {
    const cut = fakes({ lines: stream.slice(0, 3) });
    await assert.rejects(moveApplication({ appId: APP, source: cut.source, target: cut.target }), /no end record/);
    assert.ok(cut.calls.includes(`target POST /admin/v1/apps/${APP}/import/abort`));
    assert.ok(!cut.calls.some((call) => call.includes('/finish')));
    const wrong = fakes({ lines: [...stream.slice(0, 4), { t: 'end', logs: 1, events: 99, requests: 1 }] });
    await assert.rejects(moveApplication({ appId: APP, source: wrong.source, target: wrong.target }), /99 events but carried 3/);
    assert.ok(wrong.calls.includes(`target POST /admin/v1/apps/${APP}/import/abort`));
});

test('aborts when a chunk is refused, and does not blame a different application', async () => {
    const refused = fakes({ failChunk: true });
    await assert.rejects(moveApplication({ appId: APP, source: refused.source, target: refused.target }), (error: unknown) => error instanceof MoveError);
    const stranger = fakes({ lines: [{ ...stream[0], id: LOG }, ...stream.slice(1)] });
    await assert.rejects(moveApplication({ appId: APP, source: stranger.source, target: stranger.target }), /not 1111/);
});

test('a destination whose checksums differ fails the move and says which log', async () => {
    const { source, target } = fakes({ targetChecksum: { ...checksum, sha256: 'b'.repeat(64) } });
    await assert.rejects(moveApplication({ appId: APP, source, target }), /log 2222.* differs/);
    assert.deepEqual(sameChecksums([checksum], [checksum]), []);
    assert.match(sameChecksums([checksum], [])[0]!, /missing at the destination/);
    assert.match(sameChecksums([], [checksum])[0]!, /only at the destination/);
});

test('a retry clears the unfinished import an interrupted attempt left, and an unreachable destination fails the abort quietly', async () => {
    const { calls, source, target } = fakes();
    const reachable: AdminCall = async (method, path, body) => (path.endsWith('/import/abort') && calls.length === 0 ? Response.json({ error: 'gone' }, { status: 404 }) : target(method, path, body));
    await moveApplication({ appId: APP, source, target: reachable });
    assert.ok(calls.some((call) => call === `target POST /admin/v1/apps/${APP}/import/abort`));
    const down: AdminCall = async (method, path, body) => {
        if (path.endsWith('/import/abort')) throw new Error('connection refused');
        return target(method, path, body);
    };
    await moveApplication({ appId: APP, source, target: down });
});
