import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { proxyLedgerRequest } from '@hearthlog/cloudflare/gateway.js';

const ADMIN_TOKEN = 'replace-with-a-local-admin-token';
const WORKER_ORIGIN = `http://127.0.0.1:${process.env.LEDGER_WORKER_TEST_PORT ?? '8787'}`;
const execFileAsync = promisify(execFile);

interface ProvisionedLedger {
    token: string;
    appId: string;
    logId: string;
}

interface SocketFrame {
    type: string;
    event?: { version: number; id: string };
    headVersion?: number;
    reason?: string;
}

interface SocketEndpoint {
    url: string;
    protocol: string;
}

interface SocketConnection {
    socket: WebSocket;
    frames: SocketFrame[];
}

async function provision(
    request: APIRequestContext,
): Promise<ProvisionedLedger> {
    const appResponse = await request.post('/admin/v1/apps', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        data: { name: `worker-browser-${crypto.randomUUID()}` },
    });
    expect(appResponse.status()).toBe(201);
    const app = (await appResponse.json()) as {
        token: string;
        app: { id: string };
    };

    const logResponse = await request.post('/logs', {
        headers: { Authorization: `Bearer ${app.token}` },
        data: { name: 'browser-contract' },
    });
    expect(logResponse.status()).toBe(201);
    const log = (await logResponse.json()) as { id: string };
    return { token: app.token, appId: app.app.id, logId: log.id };
}

async function append(
    request: APIRequestContext,
    ledger: ProvisionedLedger,
    count: number,
): Promise<number[]> {
    const response = await request.post(`/logs/${ledger.logId}/events`, {
        headers: { Authorization: `Bearer ${ledger.token}` },
        data: {
            requestId: crypto.randomUUID(),
            events: Array.from({ length: count }, (_, index) => ({
                id: crypto.randomUUID(),
                type: 'WORKER_BROWSER_EVENT',
                entityId: `worker-browser:${crypto.randomUUID()}`,
                timestamp: Date.now() + index,
                payload: { index },
            })),
        },
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
        events: Array<{ version: number }>;
    };
    return body.events.map((event) => event.version);
}

async function openSocket(
    ledger: ProvisionedLedger,
    afterVersion: number,
): Promise<SocketConnection> {
    return connectSocket(
        socketEndpoint(ledger.logId, afterVersion),
        ledger.token,
    );
}

function socketEndpoint(logId: string, afterVersion: number): SocketEndpoint {
    const url = new URL(
        `/logs/${logId}/events/socket?afterVersion=${afterVersion}`,
        WORKER_ORIGIN,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: url.toString(), protocol: 'ledger.v1' };
}

async function connectSocket(
    endpoint: SocketEndpoint,
    token: string,
): Promise<SocketConnection> {
    const socket = new WebSocket(endpoint.url, endpoint.protocol, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const connection: SocketConnection = {
        socket,
        frames: [],
    };
    socket.on('message', (data) => {
        connection.frames.push(JSON.parse(data.toString()) as SocketFrame);
    });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('unexpected-response', (_request, response) => {
            response.resume();
            reject(
                new Error(
                    `WebSocket failed to open: HTTP ${response.statusCode}`,
                ),
            );
        });
    });
    return connection;
}

async function socketConnectionFails(
    endpoint: SocketEndpoint,
    token: string,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket = new WebSocket(endpoint.url, endpoint.protocol, {
            headers: { Authorization: `Bearer ${token}` },
        });
        let settled = false;
        const finish = (failed: boolean) => {
            if (settled) return;
            settled = true;
            resolve(failed);
        };
        socket.once('open', () => {
            socket.close();
            finish(false);
        });
        socket.once('unexpected-response', (_request, response) => {
            response.resume();
            finish(true);
        });
        socket.once('error', () => finish(true));
    });
}

test('Elysia edge preserves validation, authentication, CORS, and route contracts', async ({
    request,
}) => {
    const health = await request.get('/health');
    expect(health.status()).toBe(204);
    expect(health.headers()['cache-control']).toBe('no-store');

    const preflight = await request.fetch('/anything', {
        method: 'OPTIONS',
        headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()['access-control-allow-origin']).toBe(
        'http://127.0.0.1:5173',
    );
    expect(preflight.headers()['access-control-max-age']).toBe('86400');

    const forbiddenOrigin = await request.get('/health', {
        headers: { Origin: 'https://not-allowed.example' },
    });
    expect(forbiddenOrigin.status()).toBe(403);
    expect(await forbiddenOrigin.json()).toEqual({
        error: 'origin is not allowed',
        code: 'origin_not_allowed',
    });

    const internal = await request.get('/_internal/initialize');
    expect(internal.status()).toBe(404);
    expect(await internal.json()).toMatchObject({ code: 'not_found' });

    const anonymousUnknown = await request.get('/unknown');
    expect(anonymousUnknown.status()).toBe(401);
    expect(await anonymousUnknown.json()).toEqual({
        error: 'invalid bearer token',
        code: 'unauthorized',
    });

    const malformedAdmin = await request.fetch('/admin/v1/apps', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: '{',
    });
    expect(malformedAdmin.status()).toBe(400);
    expect(await malformedAdmin.json()).toMatchObject({
        code: 'validation_error',
    });

    const ledger = await provision(request);
    const headers = {
        Authorization: `Bearer ${ledger.token}`,
        'Content-Type': 'application/json',
    };

    const unknown = await request.get('/unknown', { headers });
    expect(unknown.status()).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'not_found' });

    const appTokenOnAdminRoute = await request.get('/admin/v1/apps', {
        headers,
    });
    expect(appTokenOnAdminRoute.status()).toBe(401);
    expect(await appTokenOnAdminRoute.json()).toEqual({
        error: 'invalid administrator token',
        code: 'unauthorized',
    });

    const adminTokenOnAppRoute = await request.get('/session', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(adminTokenOnAppRoute.status()).toBe(401);
    expect(await adminTokenOnAppRoute.json()).toEqual({
        error: 'invalid bearer token',
        code: 'unauthorized',
    });

    const missingSocketAuth = await request.get(
        `/logs/${ledger.logId}/events/socket?afterVersion=0`,
    );
    expect(missingSocketAuth.status()).toBe(401);
    expect(await missingSocketAuth.json()).toEqual({
        error: 'invalid bearer token',
        code: 'unauthorized',
    });

    const malformed = await request.fetch('/logs', {
        method: 'POST',
        headers,
        data: '{',
    });
    expect(malformed.status()).toBe(400);
    expect(await malformed.json()).toMatchObject({
        code: 'validation_error',
    });

    const unknownField = await request.post('/logs', {
        headers,
        data: { name: 'invalid', unexpected: true },
    });
    expect(unknownField.status()).toBe(400);
    expect(await unknownField.json()).toMatchObject({
        code: 'validation_error',
    });

    const invalidUuid = await request.get('/logs/not-a-uuid', { headers });
    expect(invalidUuid.status()).toBe(400);
    expect(await invalidUuid.json()).toMatchObject({
        code: 'validation_error',
    });

    const entityId = `edge-contract:${crypto.randomUUID()}`;
    const appended = await request.post(`/logs/${ledger.logId}/events`, {
        headers,
        data: {
            requestId: crypto.randomUUID(),
            events: [
                {
                    type: 'EDGE_CREATED',
                    entityId,
                    payload: { nested: { valid: true } },
                },
                {
                    type: 'EDGE_UPDATED',
                    entityId,
                    baseEntityVersion: 1,
                    payload: { sequence: 2 },
                },
            ],
        },
    });
    expect(appended.status()).toBe(200);

    const canonicalPage = await request.get(
        `/logs/${ledger.logId}/events?afterVersion=0&limit=1`,
        { headers },
    );
    expect(canonicalPage.status()).toBe(200);
    expect(
        ((await canonicalPage.json()) as { events: unknown[] }).events,
    ).toHaveLength(1);

    for (const query of [
        'after_version=0',
        'afterVersion=invalid',
        'afterVersion=-1',
        'limit=0',
        'limit=-1',
        'unexpected=1',
    ]) {
        const invalidQuery = await request.get(
            `/logs/${ledger.logId}/events?${query}`,
            { headers },
        );
        expect(invalidQuery.status(), query).toBe(400);
        expect(await invalidQuery.json()).toMatchObject({
            code: 'validation_error',
        });
    }

    const clampedPage = await request.get(
        `/logs/${ledger.logId}/events?afterVersion=0&limit=9999`,
        { headers },
    );
    expect(
        ((await clampedPage.json()) as { events: unknown[] }).events,
    ).toHaveLength(2);

    const removedEntityRoute = await request.get(
        `/logs/${ledger.logId}/entities/${encodeURIComponent(entityId)}`,
        { headers },
    );
    expect(removedEntityRoute.status()).toBe(404);
    expect(await removedEntityRoute.json()).toMatchObject({
        code: 'not_found',
    });

    const invalidSocketCursor = await request.get(
        `/logs/${ledger.logId}/events/socket?afterVersion=invalid`,
        { headers },
    );
    expect(invalidSocketCursor.status()).toBe(400);
    expect(await invalidSocketCursor.json()).toMatchObject({
        code: 'validation_error',
    });

    const applications = await request.get('/admin/v1/apps', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(await applications.json()).toMatchObject({
        apps: expect.arrayContaining([
            expect.objectContaining({ id: ledger.appId }),
        ]),
    });

    const administratorLogs = await request.get(
        `/admin/v1/apps/${ledger.appId}/logs`,
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(administratorLogs.status()).toBe(200);
    expect(await administratorLogs.json()).toMatchObject({
        logs: expect.arrayContaining([
            expect.objectContaining({
                id: ledger.logId,
                createdAt: expect.any(String),
            }),
        ]),
    });

    const applicationExport = await request.get(
        `/admin/v1/apps/${ledger.appId}/export`,
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(applicationExport.status()).toBe(200);
    expect(applicationExport.headers()['cache-control']).toBe('no-store');
    expect(applicationExport.headers()['content-disposition']).toMatch(
        /^attachment; filename="ledger-/,
    );
    expect(await applicationExport.json()).toMatchObject({
        format: 'ledger-application-export',
        version: 1,
        application: { id: ledger.appId },
        logs: expect.arrayContaining([
            expect.objectContaining({
                id: ledger.logId,
                events: expect.any(Array),
            }),
        ]),
    });

    const wrongSocketMethod = await request.fetch(
        `/logs/${ledger.logId}/events/socket?afterVersion=2`,
        { method: 'POST', headers },
    );
    expect(wrongSocketMethod.status()).toBe(404);
    expect(await wrongSocketMethod.json()).toMatchObject({
        code: 'not_found',
    });

    const revoked = await request.post(
        `/admin/v1/apps/${ledger.appId}/revoke`,
        {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
    );
    expect(revoked.status()).toBe(200);
    expect(await revoked.json()).toMatchObject({
        id: ledger.appId,
        revokedAt: expect.any(String),
    });

    const staleSession = await request.get('/session', { headers });
    expect(staleSession.status()).toBe(401);
    expect(await staleSession.json()).toMatchObject({
        code: 'unauthorized',
    });
});

test('frontend service-binding gateway remains compatible with the Elysia Worker', async ({
    request,
}) => {
    const ledger = await provision(request);
    const binding = {
        fetch: async (upstream: Request): Promise<Response> => {
            const url = new URL(upstream.url);
            const response = await request.fetch(
                `${url.pathname}${url.search}`,
                {
                    method: upstream.method,
                    headers: Object.fromEntries(upstream.headers),
                    data:
                        upstream.body === null
                            ? undefined
                            : await upstream.text(),
                },
            );
            return new Response(await response.text(), {
                status: response.status(),
                headers: response.headers(),
            });
        },
    };

    const logResponse = await proxyLedgerRequest(
        new Request('http://stor.test:8787/api/ledger/logs', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer browser-supplied-token-is-ignored',
                'Content-Type': 'application/json',
                Origin: 'http://stor.test:8787',
            },
            body: JSON.stringify({ name: 'gateway-contract' }),
        }),
        {
            CF_ACCESS_APP_AUD: 'app-audience',
            CF_ACCESS_TEAM_DOMAIN: 'https://stor.cloudflareaccess.com',
            STOR_AUTHORIZED_EMAILS: 'user@example.com',
            LEDGER: binding,
            LEDGER_AUTH_TOKEN: ledger.token,
        },
        async () => ({ email: 'user@example.com' }),
    );
    expect(logResponse.status).toBe(201);
    const log = (await logResponse.json()) as { id: string };

    const socketResponse = await proxyLedgerRequest(
        new Request(
            `http://stor.test:8787/api/ledger/logs/${log.id}/events/socket?afterVersion=0`,
            {
                headers: {
                    Origin: 'http://stor.test:8787',
                },
            },
        ),
        {
            CF_ACCESS_APP_AUD: 'app-audience',
            CF_ACCESS_TEAM_DOMAIN: 'https://stor.cloudflareaccess.com',
            STOR_AUTHORIZED_EMAILS: 'user@example.com',
            LEDGER: binding,
            LEDGER_AUTH_TOKEN: ledger.token,
        },
        async () => ({ email: 'user@example.com' }),
    );
    expect(socketResponse.status).toBe(400);
    expect(await socketResponse.json()).toMatchObject({
        code: 'invalid_subprotocol',
    });
});

test('TypeScript Worker delivers, resumes, resynchronizes, and revokes durable sockets', async ({
    request,
}) => {
    test.setTimeout(90_000);
    const ledger = await provision(request);
    const connections: SocketConnection[] = [];
    try {
        const socketA = await openSocket(ledger, 0);
        const socketB = await openSocket(ledger, 0);
        connections.push(socketA, socketB);
        await expect.poll(() => socketB.frames.at(-1)?.type).toBe('ready');

        expect(await append(request, ledger, 1)).toEqual([1]);
        await expect
            .poll(() =>
                socketB.frames
                    .filter((frame) => frame.type === 'event')
                    .map((frame) => frame.event?.version),
            )
            .toEqual([1]);

        // Simulate an ungraceful browser transport loss.
        socketB.socket.terminate();

        expect(await append(request, ledger, 2)).toEqual([2, 3]);
        const resumed = await openSocket(ledger, 1);
        connections.push(resumed);
        await expect.poll(() => resumed.frames.at(-1)?.type).toBe('ready');
        expect(
            resumed.frames
                .filter((frame) => frame.type === 'event')
                .map((frame) => frame.event?.version),
        ).toEqual([2, 3]);

        const gapLedger = await provision(request);
        expect((await append(request, gapLedger, 512)).at(-1)).toBe(512);
        expect(await append(request, gapLedger, 1)).toEqual([513]);
        const gapSocket = await openSocket(gapLedger, 0);
        connections.push(gapSocket);
        await expect
            .poll(() => gapSocket.frames[0])
            .toMatchObject({
                type: 'resync_required',
                headVersion: 513,
                reason: 'gap_too_large',
            });

        const rotate = await request.post(
            `/admin/v1/apps/${ledger.appId}/rotate-token`,
            { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
        );
        expect(rotate.status()).toBe(200);
        const rotated = (await rotate.json()) as { token: string };
        await expect
            .poll(
                () =>
                    resumed.socket.readyState === WebSocket.CLOSING ||
                    resumed.socket.readyState === WebSocket.CLOSED,
            )
            .toBe(true);

        expect(
            await socketConnectionFails(
                socketEndpoint(ledger.logId, 3),
                ledger.token,
            ),
        ).toBe(true);

        ledger.token = rotated.token;
        const rotatedSocket = await openSocket(ledger, 3);
        connections.push(rotatedSocket);
        await expect
            .poll(() => rotatedSocket.frames.at(-1)?.type)
            .toBe('ready');
        const revoke = await request.post(
            `/admin/v1/apps/${ledger.appId}/revoke`,
            {
                headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
            },
        );
        expect(revoke.status()).toBe(200);
        await expect
            .poll(
                () =>
                    rotatedSocket.socket.readyState === WebSocket.CLOSING ||
                    rotatedSocket.socket.readyState === WebSocket.CLOSED,
            )
            .toBe(true);
    } finally {
        for (const connection of connections) {
            if (connection.socket.readyState !== WebSocket.CLOSED) {
                connection.socket.terminate();
            }
        }
    }
});

test('logical export restores checksummed pages and activates a fresh token', async ({
    request,
}) => {
    const ledger = await provision(request);
    expect(await append(request, ledger, 3)).toEqual([1, 2, 3]);
    // An unfinished fork is unreadable until finalized; it must not block backups.
    const forkResponse = await request.post(`/logs/${ledger.logId}/forks`, {
        headers: { Authorization: `Bearer ${ledger.token}` },
        data: {
            requestId: crypto.randomUUID(),
            name: 'unfinished fork',
            targetVersion: 3,
            expectedSourceHeadVersion: 3,
        },
    });
    expect(forkResponse.status()).toBe(201);
    const fork = (await forkResponse.json()) as { id: string; status: string };
    expect(fork.status).toBe('preparing');
    // An author stamped by the gateway survives export, restore and checksum verification.
    const stamped = await request.post(`/logs/${ledger.logId}/events`, {
        headers: { Authorization: `Bearer ${ledger.token}`, 'X-Ledger-Actor': 'jan@example.com' },
        data: {
            requestId: crypto.randomUUID(),
            events: [{ type: 'ACTOR_NOTED', entityId: `note:${crypto.randomUUID()}`, payload: {} }],
        },
    });
    expect(stamped.status()).toBe(200);
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ledger-logical-'));
    const exportPath = path.join(temporaryRoot, 'export');
    const script = path.resolve('packages/ledger/scripts/logical-backup.ts');
    // The package scripts run this through tsx; plain Node does not map .js imports to .ts.
    const tsx = path.resolve('node_modules/.bin/tsx');

    try {
        const exported = await execFileAsync(
            tsx,
            [script, 'export', '--output', exportPath],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    LEDGER_BASE_URL: WORKER_ORIGIN,
                    LEDGER_AUTH_TOKEN: ledger.token,
                },
            },
        );
        expect(JSON.parse(exported.stdout)).toMatchObject({
            logs: 1,
            skippedLogIds: [fork.id],
        });
        const { stdout } = await execFileAsync(
            tsx,
            [
                script,
                'restore',
                '--input',
                exportPath,
                '--name',
                `restored-${crypto.randomUUID()}`,
            ],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    LEDGER_BASE_URL: WORKER_ORIGIN,
                    LEDGER_ADMIN_TOKEN: ADMIN_TOKEN,
                },
            },
        );
        const restored = JSON.parse(stdout) as {
            token: string;
            logs: Array<{ targetLogId: string }>;
        };
        expect(restored.logs).toHaveLength(1);
        const eventsResponse = await request.get(
            `/logs/${restored.logs[0].targetLogId}/events?afterVersion=0&limit=512`,
            { headers: { Authorization: `Bearer ${restored.token}` } },
        );
        expect(eventsResponse.status()).toBe(200);
        const restoredEvents = ((await eventsResponse.json()) as {
            events: Array<{ actor?: string }>;
        }).events;
        expect(restoredEvents).toHaveLength(4);
        expect(restoredEvents.map((event) => event.actor)).toEqual([
            undefined, undefined, undefined, 'jan@example.com',
        ]);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test('Worker append conflicts preserve the canonical response and atomicity contract', async ({
    request,
}) => {
    const ledger = await provision(request);
    const headers = { Authorization: `Bearer ${ledger.token}` };
    const entityId = `contract:${crypto.randomUUID()}`;
    const initial = await request.post(`/logs/${ledger.logId}/events`, {
        headers,
        data: {
            requestId: crypto.randomUUID(),
            events: [
                {
                    type: 'CONTRACT_CREATED',
                    entityId,
                    payload: { step: 1 },
                },
                {
                    type: 'CONTRACT_UPDATED',
                    entityId,
                    baseEntityVersion: 1,
                    payload: { step: 2 },
                },
            ],
        },
    });
    expect(initial.status()).toBe(200);

    const conflict = await request.post(`/logs/${ledger.logId}/events`, {
        headers,
        data: {
            requestId: crypto.randomUUID(),
            events: [
                {
                    type: 'CONTRACT_UPDATED',
                    entityId,
                    baseEntityVersion: 1,
                    payload: { step: 3 },
                },
            ],
        },
    });
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({
        code: 'entity_conflict',
        entityId,
        currentEntityVersion: 2,
        currentLogVersion: 2,
    });

    const log = await request.get(`/logs/${ledger.logId}`, { headers });
    expect(((await log.json()) as { headVersion: number }).headVersion).toBe(2);
});
