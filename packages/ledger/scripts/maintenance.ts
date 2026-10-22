#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { LogMaintenance } from '@hearthlog/contracts/history/checkpoint';

const { values } = parseArgs({ options: {
    log: { type: 'string' }, kind: { type: 'string', default: 'snapshot' },
    'request-id': { type: 'string' }, resume: { type: 'boolean' }, once: { type: 'boolean' }, help: { type: 'boolean' },
} });

async function main(): Promise<void> {
    if (values.help) {
        console.log('ledger maintenance --log <uuid> [--kind snapshot|compact] [--request-id <uuid>] [--resume] [--once]');
        console.log('Uses LEDGER_BASE_URL and LEDGER_AUTH_TOKEN. Compaction retains original events in the private archive.');
        return;
    }
    if (!values.log || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.log)) throw new Error('--log must be a UUID');
    if (values.kind !== 'snapshot' && values.kind !== 'compact') throw new Error('--kind must be snapshot or compact');
    const base = process.env.LEDGER_BASE_URL;
    const token = process.env.LEDGER_AUTH_TOKEN;
    if (!base || !token) throw new Error('Set LEDGER_BASE_URL and LEDGER_AUTH_TOKEN');
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Use an HTTP(S) Ledger URL without embedded credentials');
    const path = `/logs/${values.log}/maintenance`;
    async function request(suffix = '', body?: unknown): Promise<LogMaintenance> {
        const response = await fetch(`${origin.href.replace(/\/$/, '')}${path}${suffix}`, {
            method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new Error(`Ledger maintenance request failed (HTTP ${response.status})`);
        return response.json() as Promise<LogMaintenance>;
    }
    let state = await request();
    const requestId = values['request-id'] ?? (values.resume ? state.job?.id : randomUUID());
    if (!requestId) throw new Error('No maintenance operation to resume');
    if (!values.resume) {
        state = await request('', { requestId, kind: values.kind,
            expectedCheckpointId: state.checkpoint?.id, expectedGeneration: state.storageGeneration });
    }
    do {
        if (state.job?.status === 'complete') break;
        state = await request('/step', { requestId });
        console.log(JSON.stringify(state.job));
        if (state.job?.status === 'failed') throw new Error(state.job.error ?? 'Maintenance failed');
    } while (!values.once && state.job?.status !== 'complete' && state.job?.status !== 'paused');
    console.log(JSON.stringify({ logId: values.log, requestId, status: state.job?.status,
        checkpointId: state.checkpoint?.id ?? null, throughVersion: state.checkpoint?.throughVersion ?? 0,
        compactedThroughVersion: state.compactedThroughVersion, storageGeneration: state.storageGeneration }));
}

try { await main(); }
catch (cause) { console.error(cause instanceof Error ? cause.message : 'Maintenance failed'); process.exitCode = 1; }
