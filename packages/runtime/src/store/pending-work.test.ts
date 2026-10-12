import { describe, expect, it } from 'vitest';

import {
    buildPendingWorkFile,
    classifyImportFailure,
    parsePendingWorkFile,
    PendingWorkFileError,
    summarizeImport,
} from './pending-work.js';

const LOG = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const operation = (requestId = REQUEST) => ({
    logId: LOG,
    status: 'failed',
    createdAt: '2026-10-08T10:00:00.000Z',
    request: { requestId, events: [{ id: EVENT, type: 'CALENDAR_EVENT_ADDED', entityId: 'calendar_event:1', payload: { id: 'a', title: 'Dentist' } }] },
});

describe('pending work file', () => {
    it('round-trips the original request bodies, IDs included', () => {
        const file = buildPendingWorkFile({ origin: 'https://old.example', destination: 'https://new.example', operations: [operation() as never], now: new Date('2026-10-08T12:00:00Z') });
        const read = parsePendingWorkFile(JSON.stringify(file));
        expect(read.operations[0]!.request).toEqual(operation().request);
        expect(read).toMatchObject({ origin: 'https://old.example', destination: 'https://new.example', exportedAt: '2026-10-08T12:00:00.000Z' });
    });

    it('refuses files that are not ours, not whole, or would send something the Ledger could not recognize', () => {
        const base = buildPendingWorkFile({ origin: 'o', destination: null, operations: [operation() as never] });
        expect(() => parsePendingWorkFile('not json')).toThrow(PendingWorkFileError);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, format: 'other' }))).toThrow(/not a pending-work file/);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, version: 2 }))).toThrow(/Unsupported/);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, operations: [{ ...operation(), logId: 'x' }] }))).toThrow(/valid log/);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, operations: [{ ...operation(), request: { requestId: 'x', events: [] } }] }))).toThrow(/request ID/);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, operations: [{ ...operation(), request: { requestId: REQUEST, events: [] } }] }))).toThrow(/no events/);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, operations: [{ ...operation(), request: { requestId: REQUEST, events: [{ id: 'bad', type: 't', entityId: 'e', payload: {} }] } }] }))).toThrow(/no ID/);
        expect(() => parsePendingWorkFile(JSON.stringify({ ...base, operations: [operation(), operation()] }))).toThrow(/repeats a request/);
    });

    it('says what each failure means, and treats a paused or moved workspace as try-again-later', () => {
        expect(classifyImportFailure(409, 'idempotency_mismatch')).toBe('conflict');
        expect(classifyImportFailure(409, 'event_already_accepted')).toBe('conflict');
        expect(classifyImportFailure(404, 'log_not_found')).toBe('missing_log');
        expect(classifyImportFailure(503, 'tenant_migrating')).toBe('unavailable');
        expect(classifyImportFailure(410, 'tenant_moved')).toBe('unavailable');
        expect(classifyImportFailure(undefined, undefined)).toBe('unavailable');
        expect(classifyImportFailure(422, 'invalid_event_payload')).toBe('refused');
        const report = summarizeImport([
            { requestId: 'a', outcome: 'applied', message: '' },
            { requestId: 'b', outcome: 'conflict', message: '' },
        ]);
        expect(report).toMatchObject({ applied: 1, notApplied: 1 });
    });
});
