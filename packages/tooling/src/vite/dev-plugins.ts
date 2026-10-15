/**
 * The Vite plugins that stand in for the Worker during local development and the hermetic browser journeys:
 * the Ledger gateway origin guard, the invoice PDF, received-file, and extraction routes, the AI decisions
 * route, and the Ledger stub. None of them runs in a build.
 */

import type { Plugin } from 'vite';

import { localGatewayOriginAllowed } from '../dev/local-development.js';

export const localLedgerGatewayPath = '/api/ledger';
export const localInvoiceRendererPath = '/api/invoice-generation';

export function localLedgerOriginGuardPlugin(enabled: boolean): Plugin {
	return {
		name: 'local-ledger-origin-guard',
		configureServer(server) {
			if (!enabled) return;
			server.middlewares.use((request, response, next) => {
				if (!isLedgerGatewayRequest(request.url)) return next();
				if (
					localGatewayOriginAllowed(
						request.headers.origin,
						request.headers.host,
					)
				) {
					return next();
				}
				response.statusCode = 403;
				response.setHeader('Content-Type', 'application/json');
				response.end(
					JSON.stringify({
						error: 'Cross-origin local Ledger requests are not allowed',
						code: 'origin_not_allowed',
					}),
				);
			});
			server.httpServer?.prependListener('upgrade', (request, socket) => {
				if (
					!isLedgerGatewayRequest(request.url) ||
					localGatewayOriginAllowed(
						request.headers.origin,
						request.headers.host,
					)
				) {
					return;
				}
				request.url = '/__rejected-local-ledger-upgrade';
				socket.write(
					'HTTP/1.1 403 Forbidden\r\n' +
						'Connection: close\r\n' +
						'Content-Length: 0\r\n\r\n',
				);
				socket.destroy();
			});
		},
	};
}

export function isLedgerGatewayRequest(url: string | undefined): boolean {
	if (!url) return false;
	const pathname = new URL(url, 'http://local.invalid').pathname;
	return (
		pathname === localLedgerGatewayPath ||
		pathname.startsWith(`${localLedgerGatewayPath}/`)
	);
}

/**
 * Local dev runs the static app without the Stor Worker or R2. The cached
 * `/api/invoice-generation/logs/*` routes therefore fall back to the
 * stateless renderer (POST) and accept scoped cleanup (DELETE) locally, while
 * production and staging always use the Worker's cache.
 */
export function localInvoicePdfGatewayFallbackPlugin(enabled: boolean): Plugin {
	return {
		name: 'local-invoice-pdf-gateway-fallback',
		configureServer(server) {
			if (!enabled) return;
			server.middlewares.use((request, response, next) => {
				if (!request.url) return next();
				const method = request.method?.toUpperCase();
				if (method !== 'POST' && method !== 'DELETE') return next();
				const url = new URL(request.url, 'http://local.invalid');
				const scoped = url.pathname.match(
					/^\/api\/invoice-generation\/logs\/[0-9a-fA-F-]+\/(?:pdf|invoices\/[0-9a-zA-Z_-]+)$/,
				);
				if (!scoped) return next();
				if (method === 'DELETE') {
					response.statusCode = 204;
					response.setHeader('Cache-Control', 'no-store');
					response.end();
					return;
				}
				request.url = `${localInvoiceRendererPath}/pdf${url.search}`;
				next();
			});
		},
	};
}

/**
 * The app's Worker/R2 binding is absent in Vite dev. Keep original received
 * PDF and ISDOC originals in this server process so the same-origin upload and
 * preview flow can be exercised locally; the browser's IndexedDB copy remains
 * the offline one.
 */
export function localReceivedInvoiceFilesPlugin(): Plugin {
    const files = new Map<string, { bytes: Buffer; name: string; contentType: string }>();
    const pdfRoute = /^\/api\/received-invoice-files\/v1\/logs\/[0-9a-fA-F-]{36}\/invoices\/[0-9a-fA-F-]{36}\/files\/[0-9a-fA-F-]{36}$/;
    const isdocRoute = /^\/api\/received-invoice-files\/v1\/logs\/[0-9a-fA-F-]{36}\/invoices\/[0-9a-fA-F-]{36}\/isdoc\/[0-9a-fA-F-]{36}$/;
    return {
        name: 'local-received-invoice-files',
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                if (!request.url) return next();
                const url = new URL(request.url, 'http://local.invalid');
                const isPdf = pdfRoute.test(url.pathname);
                const isIsdoc = !isPdf && isdocRoute.test(url.pathname);
                if (!isPdf && !isIsdoc) return next();
                const maxBytes = isPdf ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
                const contentType = isPdf ? 'application/pdf' : 'application/xml; charset=utf-8';
                const defaultName = isPdf ? 'invoice.pdf' : 'invoice.isdoc';
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                if (request.method === 'GET') {
                    const file = files.get(url.pathname);
                    if (!file) { response.statusCode = 404; response.end('File not found'); return; }
                    response.setHeader('Content-Type', file.contentType);
                    response.setHeader('Content-Disposition', `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${file.name.replace(/["\\]/g, '_')}"`);
                    response.end(file.bytes);
                    return;
                }
                if (request.method !== 'PUT') { response.statusCode = 405; response.end(); return; }
                const incomingType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
                const typeAccepted = isPdf
                    ? incomingType === 'application/pdf'
                    : ['application/xml', 'application/x-isdoc', 'text/xml'].includes(incomingType ?? '');
                if (!typeAccepted) { response.statusCode = 415; response.end(isPdf ? 'Upload a PDF' : 'Upload ISDOC XML'); return; }
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > maxBytes) { response.statusCode = 413; response.end('File too large'); return; }
                    chunks.push(chunk);
                }
                const bytes = Buffer.concat(chunks);
                if (!hasValidSignature(bytes, isPdf)) {
                    response.statusCode = 415;
                    response.end(isPdf ? 'Invalid PDF' : 'Invalid ISDOC XML');
                    return;
                }
                let name = String(request.headers['x-stor-filename'] ?? defaultName);
                try { name = decodeURIComponent(name); } catch { /* keep encoded value */ }
                name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 180) || defaultName;
                if (!files.has(url.pathname)) files.set(url.pathname, { bytes, name, contentType });
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ fileId: url.pathname.split('/').at(-1), size: files.get(url.pathname)!.bytes.length, etag: 'local' }));
            });
        },
    };
}

/** Matches the Worker's upload signature checks for local dev. */
export function hasValidSignature(bytes: Buffer, isPdf: boolean): boolean {
    if (isPdf) return bytes.subarray(0, 5).toString() === '%PDF-';
    let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    while (index < bytes.length && [0x09, 0x0a, 0x0d, 0x20].includes(bytes[index]!)) index += 1;
    return index < bytes.length && bytes[index] === 0x3c;
}

/**
 * Local dev runs without the Worker, its Access session and its secrets. The
 * extraction route answers 503 with the same error shape as the deployed
 * Worker when no credential is configured, so the UI hides its AI button
 * instead of parsing the SPA fallback. AI reading is exercised against a
 * deployed environment where INVOICE_EXTRACTION_* is provisioned.
 */
export function localInvoiceExtractionPlugin(): Plugin {
    const route = /^\/api\/received-invoice-extraction\/v1\/logs\/[0-9a-fA-F-]{36}$/;
    return {
        name: 'local-invoice-extraction',
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                if (!request.url) return next();
                const url = new URL(request.url, 'http://local.invalid');
                if (!route.test(url.pathname)) return next();
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.setHeader('Content-Type', 'application/json; charset=utf-8');
                response.statusCode = 503;
                response.end(JSON.stringify({
                    code: 'extraction_unconfigured',
                    error: 'AI invoice reading runs in the deployed Worker; complete the form manually in local development.',
                }));
            });
        },
    };
}

/**
 * Local dev has no Workers AI binding. The decision route answers 503 with the
 * deployed Worker's error shape, so the UI hides its suggestions. With
 * VITE_E2E=1 it answers from a small deterministic table instead, keeping the
 * browser journeys hermetic: known fixture names get a category at 0.95, and
 * everything else is `none`.
 */
export function localAiDecisionsPlugin(deterministic: boolean): Plugin {
    const route = /^\/api\/ai\/v1\/logs\/[0-9a-fA-F-]{36}\/decisions\/(category-pick|invoice-expense-type)$/;
    const categories: Array<[RegExp, string]> = [
        [/albert|billa|tesco|grocer/i, 'food'],
        [/shell|fuel|taxi/i, 'transport'],
        [/netflix|spotify/i, 'subscriptions'],
        [/pharmacy|doctor/i, 'health'],
    ];
    const expenseTypes: Array<[RegExp, string]> = [
        [/jetbrains|software|licen[cs]e/i, 'software'],
        [/telecom|internet|mobile/i, 'telecom'],
    ];
    return {
        name: 'local-ai-decisions',
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                if (!request.url) return next();
                const url = new URL(request.url, 'http://local.invalid');
                const match = route.exec(url.pathname);
                if (!match) return next();
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.setHeader('Content-Type', 'application/json; charset=utf-8');
                if (!deterministic) {
                    response.statusCode = 503;
                    response.end(JSON.stringify({
                        code: 'ai_unconfigured',
                        error: 'AI decisions run in the deployed Worker; choose values manually in local development.',
                    }));
                    return;
                }
                const body = await readJsonBody(request);
                const items = Array.isArray(body?.items) ? body.items as Array<Record<string, unknown>> : [];
                const table = match[1] === 'category-pick' ? categories : expenseTypes;
                response.end(JSON.stringify({
                    model: 'e2e-table',
                    decisions: items.map((item) => {
                        const text = `${item.name ?? ''} ${item.supplier ?? ''} ${item.description ?? ''}`;
                        const hit = table.find(([pattern]) => pattern.test(text));
                        return { id: item.id, option: hit ? hit[1] : 'none', probability: hit ? 0.95 : 0 };
                    }),
                }));
            });
        },
    };
}

/**
 * E2E runs without the Ledger Worker. The app still initializes its Ledger
 * client (session, log selection, event downloads) before local data opens, so
 * the dev server answers the read-only contract deterministically. Network
 * sync is disabled in E2E, and reference tests overlay their own stateful
 * browser-level mocks; this keeps `pnpm test` from depending on `ledger:dev`.
 */
export function e2eLedgerStubPlugin(enabled: boolean): Plugin {
    const gateway = '/api/ledger';
    // A UUID-shaped log id keeps the local file and PDF middlewares
    // (received-invoice files, invoice generation, extraction) matching.
    const logId = 'e2e00000-0000-4000-8000-000000000000';
    const session = {
        appId: 'e2e',
        principalId: 'owner',
        capabilities: ['action-metadata-v1', 'workspace-restore-v1', 'event-excision-v1'],
    };
    const logs = {
        logs: [{ id: logId, name: 'default', headVersion: 0, lastUpdatedAt: null }],
    };
    return {
        name: 'e2e-ledger-stub',
        configureServer(server) {
            if (!enabled) return;
            server.middlewares.use(async (request, response, next) => {
                if (!request.url) return next();
                const url = new URL(request.url, 'http://local.invalid');
                if (url.pathname !== gateway && !url.pathname.startsWith(`${gateway}/`)) {
                    return next();
                }
                const method = (request.method ?? 'GET').toUpperCase();
                const suffix = url.pathname.slice(gateway.length);
                const respond = (status: number, body: unknown) => {
                    response.statusCode = status;
                    response.setHeader('Cache-Control', 'no-store');
                    response.setHeader('Content-Type', 'application/json; charset=utf-8');
                    response.end(JSON.stringify(body));
                };
                if (method === 'POST' && suffix.endsWith('/events')) {
                    // Acknowledge appends so the durable outbox can drain without
                    // a real Ledger. The stub is intentionally stateless: E2E
                    // resets its local database per test, so replayed events
                    // must not leak between tests.
                    const body = await readJsonBody(request);
                    const events = Array.isArray(body?.events) ? body.events : [];
                    const actionId = typeof body?.actionId === 'string' ? body.actionId : undefined;
                    const stored = events.map((event: Record<string, unknown>, index: number) => ({
                        ...event,
                        entityVersion: (Number(event.baseEntityVersion) || 0) + 1,
                        version: index + 1,
                        ...(actionId
                            ? { action: { id: actionId, index, size: events.length } }
                            : {}),
                    }));
                    respond(200, { newVersion: stored.length, events: stored });
                    return;
                }
                if (method !== 'GET') return next();
                let body: unknown;
                if (suffix === '/session') body = session;
                else if (suffix === '/logs') body = logs;
                else if (suffix.endsWith('/events')) body = { events: [] };
                else {
                    respond(404, { error: 'Not found', code: 'not_found' });
                    return;
                }
                respond(200, body);
            });
        },
    };
}

export async function readJsonBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** Real S3 signing against loopback MinIO; no production credentials or Access bypass reach a deployed build. */
export function localStashMediaPlugin(credential?: import('../dev/local-development.js').LocalLedgerCredential): Plugin {
    return {
        name: 'local-stash-media',
        configureServer(server) {
            server.middlewares.use(async (incoming, outgoing, next) => {
                if (!incoming.url?.startsWith('/api/stash-media/v1/')) return next();
                const respond = (status: number, message: string) => { outgoing.statusCode = status; outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify({ error: message, code: 'local_media_unavailable' })); };
                if (!localGatewayOriginAllowed(incoming.headers.origin, incoming.headers.host) || incoming.headers['sec-fetch-site'] === 'cross-site') return respond(403, 'Cross-origin local media requests are not allowed');
                if (!credential) return respond(503, 'Start the local Ledger and run ledger:provision-local before uploading videos locally');
                try {
                    const [{ loadModules }, { loadTenantConfig }, { activeSiteId }] = await Promise.all([import('../compose/compose-modules.js'), import('../tenants/tenant-config.js'), import('../root.js')]);
                    const config = await loadTenantConfig(), site = config.sites.find(site => site.id === activeSiteId());
                    const module = loadModules().find(module => module.manifest.server?.routes?.includes('/api/stash-media/v1') && module.manifest.features.some(feature => site?.features.some(enabled => enabled === feature.id)));
                    if (!module) return respond(404, 'Video media is not enabled for this site');
                    const endpoint = new URL(process.env.STASH_MEDIA_DEV_ENDPOINT || 'http://127.0.0.1:9000');
                    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) return respond(503, 'Development media storage must use a loopback MinIO endpoint');
                    const { handleStashMediaRequest } = await server.ssrLoadModule(`${module.directory}/src/server/media.ts`);
                    const chunks: Buffer[] = []; let size = 0;
                    for await (const chunk of incoming) { size += chunk.length; if (size > 1024 * 1024) return respond(413, 'Media control request is too large'); chunks.push(Buffer.from(chunk)); }
                    const headers = new Headers();
                    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
                    const request = new Request(new URL(incoming.url, `http://${incoming.headers.host}`), { method: incoming.method, headers, ...(size ? { body: Buffer.concat(chunks) } : {}) });
                    const env = {
                        STASH_MEDIA_ENDPOINT: endpoint.origin, STASH_MEDIA_BUCKET: 'hearthlog-dev', STASH_MEDIA_REGION: 'us-east-1',
                        STASH_MEDIA_KEY_ID: 'hearthlog-local', STASH_MEDIA_APP_KEY: 'hearthlog-local-only', LEDGER_AUTH_TOKEN: credential.token,
                        LEDGER: { fetch: (request: Request) => { const url = new URL(request.url); return fetch(new URL(`${url.pathname}${url.search}`, credential.baseUrl), { method: request.method, headers: request.headers }); } },
                    };
                    const response: Response = await handleStashMediaRequest(request, env, async () => ({ email: 'local@example.invalid' }));
                    outgoing.statusCode = response.status;
                    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
                    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
                    outgoing.end();
                } catch { respond(503, 'Local video storage is unavailable. Check that MinIO and the local Ledger are running'); }
            });
        },
    };
}
