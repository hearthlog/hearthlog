import { describe, expect, it, vi } from 'vitest';

import {
    proxyAccessSession,
    proxyLedgerAdminRequest,
    proxyLedgerRequest,
    serveAssetOrAppShell,
} from './gateway';
import {
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
} from './access-auth';

const storAccess = {
    CF_ACCESS_APP_AUD: 'app-audience',
    CF_ACCESS_TEAM_DOMAIN: 'https://stor.cloudflareaccess.com',
    STOR_AUTHORIZED_EMAILS: 'user@example.com',
};
const allowStor = async () => ({ email: 'user@example.com' });

describe('Ledger frontend gateway', () => {
    it('injects the server-side bearer token into ordinary requests', async () => {
        const fetch = vi.fn(async (request: Request) => {
            expect(new URL(request.url).pathname).toBe('/logs');
            expect(request.headers.get('authorization')).toBe(
                'Bearer server-secret',
            );
            expect(request.headers.get('origin')).toBeNull();
            return Response.json({ logs: [] });
        });
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs', {
                headers: {
                    Authorization: 'Bearer browser-secret',
                    Origin: 'https://stor.example',
                },
            }),
            {
                ...storAccess,
                LEDGER: { fetch },
                LEDGER_AUTH_TOKEN: 'server-secret',
            },
            allowStor,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ logs: [] });
    });

    it('authenticates and passes WebSocket upgrades through without buffering', async () => {
        const upstream = new Response(null, { status: 204 });
        const fetch = vi.fn(async (request: Request) => {
            expect(new URL(request.url).pathname).toBe(
                '/logs/one/events/socket',
            );
            expect(new URL(request.url).searchParams.get('afterVersion')).toBe(
                '7',
            );
            expect(request.headers.get('authorization')).toBe(
                'Bearer server-secret',
            );
            expect(request.headers.get('origin')).toBeNull();
            expect(request.headers.get('upgrade')).toBe('websocket');
            return upstream;
        });
        const response = await proxyLedgerRequest(
            new Request(
                'https://stor.example/api/ledger/logs/one/events/socket?afterVersion=7',
                {
                    headers: {
                        Origin: 'https://stor.example',
                        Upgrade: 'websocket',
                        'Sec-WebSocket-Protocol': 'ledger.v1',
                    },
                },
            ),
            {
                ...storAccess,
                LEDGER: { fetch },
                LEDGER_AUTH_TOKEN: 'server-secret',
            },
            allowStor,
        );
        expect(response).toBe(upstream);
    });

    it('rejects cross-origin use before the application token is attached', async () => {
        const fetch = vi.fn();
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs', {
                method: 'POST',
                headers: { Origin: 'https://attacker.example' },
            }),
            {
                ...storAccess,
                LEDGER: { fetch },
                LEDGER_AUTH_TOKEN: 'server-secret',
            },
            allowStor,
        );
        expect(response.status).toBe(403);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps fork finalization behind the file preparation route', async () => {
        const fetch = vi.fn();
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs/one/finalize-fork', { method: 'POST' }),
            { ...storAccess, LEDGER: { fetch }, LEDGER_AUTH_TOKEN: 'server-secret' },
            allowStor,
        );
        expect(response.status).toBe(403);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('attaches the server token only for a verified Access identity', async () => {
        const fetch = vi.fn();
        const authorize = vi.fn(async () => {
            throw new LedgerAdminAuthorizationError();
        });
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs', {
                headers: { Origin: 'https://stor.example' },
            }),
            { ...storAccess, LEDGER: { fetch }, LEDGER_AUTH_TOKEN: 'server-secret' },
            authorize,
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'ledger_gateway_forbidden' });
        expect(authorize).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports a missing Access configuration as unavailable', async () => {
        const fetch = vi.fn();
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs'),
            { ...storAccess, LEDGER: { fetch }, LEDGER_AUTH_TOKEN: 'server-secret' },
            async () => {
                throw new LedgerAdminConfigurationError('CF_ACCESS_APP_AUD is not configured');
            },
        );
        expect(response.status).toBe(503);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('stamps the verified identity as the author, replacing any browser-supplied one', async () => {
        const fetch = vi.fn(async (request: Request) => {
            expect(request.headers.get('x-ledger-actor')).toBe('user@example.com');
            return Response.json({ logs: [] });
        });
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs/one/events', {
                method: 'POST',
                headers: { 'X-Ledger-Actor': 'someone-else@example.com', 'Content-Type': 'application/json' },
                body: '{}',
            }),
            { ...storAccess, LEDGER: { fetch }, LEDGER_AUTH_TOKEN: 'server-secret' },
            allowStor,
        );
        expect(response.status).toBe(200);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('keeps browser credentials out of the Ledger request', async () => {
        const fetch = vi.fn(async (request: Request) => {
            expect(request.headers.get('cookie')).toBeNull();
            expect(request.headers.get('cf-access-jwt-assertion')).toBeNull();
            return Response.json({ logs: [] });
        });
        const response = await proxyLedgerRequest(
            new Request('https://stor.example/api/ledger/logs', {
                headers: {
                    Cookie: 'CF_Authorization=browser-session',
                    'Cf-Access-Jwt-Assertion': 'browser-jwt',
                },
            }),
            { ...storAccess, LEDGER: { fetch }, LEDGER_AUTH_TOKEN: 'server-secret' },
            allowStor,
        );
        expect(response.status).toBe(200);
        expect(fetch).toHaveBeenCalledOnce();
    });
});

describe('Access user session gateway', () => {
    const identity = { email: 'user@example.com' };
    const env = {
        CF_ACCESS_APP_AUD: 'app-audience',
        CF_ACCESS_TEAM_DOMAIN: 'https://stor.cloudflareaccess.com',
    };

    it('returns the verified Access identity without contacting another service', async () => {
        const authorize = vi.fn(async () => identity);
        const response = await proxyAccessSession(
            new Request('https://stor.example/api/session', {
                headers: { Origin: 'https://stor.example' },
            }),
            env,
            authorize,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual(identity);
        expect(authorize).toHaveBeenCalledOnce();
    });

    it('rejects cross-origin and non-GET requests before authorization', async () => {
        const authorize = vi.fn(async () => identity);
        const crossOrigin = await proxyAccessSession(
            new Request('https://stor.example/api/session', {
                headers: { Origin: 'https://attacker.example' },
            }),
            env,
            authorize,
        );
        const nonGet = await proxyAccessSession(
            new Request('https://stor.example/api/session', { method: 'POST' }),
            env,
            authorize,
        );

        expect(crossOrigin.status).toBe(403);
        expect(nonGet.status).toBe(405);
        expect(authorize).not.toHaveBeenCalled();
    });

    it('maps verifier failures to safe uncached responses', async () => {
        const forbidden = await proxyAccessSession(
            new Request('https://stor.example/api/session'),
            env,
            async () => {
                throw new LedgerAdminAuthorizationError();
            },
        );
        const unconfigured = await proxyAccessSession(
            new Request('https://stor.example/api/session'),
            env,
            async () => {
                throw new LedgerAdminConfigurationError('missing audience');
            },
        );

        expect(forbidden.status).toBe(403);
        expect(unconfigured.status).toBe(503);
        expect(forbidden.headers.get('cache-control')).toBe('no-store');
        expect(unconfigured.headers.get('cache-control')).toBe('no-store');
    });
});

describe('Ledger administrator gateway', () => {
    const identity = { email: 'owner@example.com' };

    it('returns the verified Access identity without calling Ledger', async () => {
        const fetch = vi.fn();
        const authorize = vi.fn(async () => identity);
        const response = await proxyLedgerAdminRequest(
            new Request('https://stor.example/api/ledger/admin/v1/session', {
                headers: {
                    'Cf-Access-Jwt-Assertion': 'access-jwt',
                    Origin: 'https://stor.example',
                },
            }),
            adminEnv(fetch),
            authorize,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual(identity);
        expect(authorize).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not expose the administrator gateway on a non-admin tenant', async () => {
        const fetch = vi.fn();
        const authorize = vi.fn(async () => identity);
        const response = await proxyLedgerAdminRequest(
            new Request('https://delta.example/api/ledger/admin/v1/apps'),
            { ...adminEnv(fetch), STOR_ADMIN_ENABLED: 'false' },
            authorize,
        );

        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(authorize).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('injects the admin token and strips browser credentials before proxying', async () => {
        const fetch = vi.fn(async (request: Request) => {
            expect(new URL(request.url).pathname).toBe('/admin/v1/apps');
            expect(request.headers.get('authorization')).toBe(
                'Bearer ledger-admin-secret',
            );
            expect(request.headers.get('cf-access-jwt-assertion')).toBeNull();
            expect(request.headers.get('cf-access-client-id')).toBeNull();
            expect(request.headers.get('cf-access-client-secret')).toBeNull();
            expect(request.headers.get('cookie')).toBeNull();
            expect(request.headers.get('origin')).toBeNull();
            expect(request.headers.get('proxy-authorization')).toBeNull();
            return Response.json({ apps: [] });
        });
        const response = await proxyLedgerAdminRequest(
            new Request('https://stor.example/api/ledger/admin/v1/apps', {
                headers: {
                    Authorization: 'Bearer browser-secret',
                    'Cf-Access-Client-Id': 'browser-client-id',
                    'Cf-Access-Client-Secret': 'browser-client-secret',
                    Cookie: 'CF_Authorization=cookie',
                    'Cf-Access-Jwt-Assertion': 'access-jwt',
                    Origin: 'https://stor.example',
                    'Proxy-Authorization': 'Bearer proxy-secret',
                },
            }),
            adminEnv(fetch),
            async () => identity,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ apps: [] });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('allows read-only per-app log and export routes without buffering responses', async () => {
        const appId = '11111111-1111-4111-8111-111111111111';
        const fetch = vi.fn(async (request: Request) => {
            expect(request.headers.get('authorization')).toBe(
                'Bearer ledger-admin-secret',
            );
            return new Response('{"logs":[]}', {
                headers: {
                    'Content-Disposition':
                        'attachment; filename="ledger-stor.json"',
                    'Content-Type': 'application/json',
                },
            });
        });
        const env = adminEnv(fetch);

        const logs = await proxyLedgerAdminRequest(
            new Request(
                `https://stor.example/api/ledger/admin/v1/apps/${appId}/logs`,
            ),
            env,
            async () => identity,
        );
        expect(logs.status).toBe(200);
        expect(await logs.text()).toBe('{"logs":[]}');

        const download = await proxyLedgerAdminRequest(
            new Request(
                `https://stor.example/api/ledger/admin/v1/apps/${appId}/export`,
            ),
            env,
            async () => identity,
        );
        expect(download.status).toBe(200);
        expect(download.headers.get('cache-control')).toBe('no-store');
        expect(download.headers.get('content-disposition')).toContain(
            'ledger-stor.json',
        );
        expect(await download.text()).toBe('{"logs":[]}');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('only permits the accepted route and method shapes', async () => {
        const authorize = vi.fn(async () => identity);
        const env = adminEnv(vi.fn());
        const invalidRequests = [
            new Request('https://stor.example/api/ledger/admin/v1/apps', {
                method: 'DELETE',
            }),
            new Request(
                'https://stor.example/api/ledger/admin/v1/apps/not-a-uuid/revoke',
                {
                    method: 'POST',
                },
            ),
            new Request(
                'https://stor.example/api/ledger/admin/v1/apps/11111111-1111-4111-8111-111111111111/logs',
                { method: 'POST' },
            ),
            new Request(
                'https://stor.example/api/ledger/admin/v1/apps/11111111-1111-4111-8111-111111111111/export',
                { method: 'POST' },
            ),
            new Request('https://stor.example/api/ledger/admin/v1/unknown'),
        ];

        for (const request of invalidRequests) {
            const response = await proxyLedgerAdminRequest(
                request,
                env,
                authorize,
            );
            expect(response.status).toBe(404);
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
        expect(authorize).not.toHaveBeenCalled();
        expect(env.LEDGER.fetch).not.toHaveBeenCalled();
    });

    it('rejects cross-origin requests before authorization', async () => {
        const authorize = vi.fn(async () => identity);
        const env = adminEnv(vi.fn());
        const response = await proxyLedgerAdminRequest(
            new Request('https://stor.example/api/ledger/admin/v1/apps', {
                headers: { Origin: 'https://attacker.example' },
            }),
            env,
            authorize,
        );

        expect(response.status).toBe(403);
        expect(authorize).not.toHaveBeenCalled();
        expect(env.LEDGER.fetch).not.toHaveBeenCalled();
    });

    it('returns safe errors for missing configuration and failed authorization', async () => {
        const env = adminEnv(vi.fn());
        const missingSecret = await proxyLedgerAdminRequest(
            new Request('https://stor.example/api/ledger/admin/v1/apps'),
            { ...env, LEDGER_ADMIN_TOKEN: '' },
            async () => identity,
        );
        expect(missingSecret.status).toBe(503);

        const forbidden = await proxyLedgerAdminRequest(
            new Request('https://stor.example/api/ledger/admin/v1/apps'),
            env,
            async () => {
                throw new LedgerAdminAuthorizationError();
            },
        );
        expect(forbidden.status).toBe(403);

        const verifierUnconfigured = await proxyLedgerAdminRequest(
            new Request('https://stor.example/api/ledger/admin/v1/apps'),
            env,
            async () => {
                throw new LedgerAdminConfigurationError('missing audience');
            },
        );
        expect(verifierUnconfigured.status).toBe(503);
        expect(env.LEDGER.fetch).not.toHaveBeenCalled();
    });
});

describe('frontend asset routing', () => {
    it('serves the app shell for missing navigation routes', async () => {
        const fetch = vi.fn(async (request: Request) => {
            const pathname = new URL(request.url).pathname;
            return pathname === '/index.html'
                ? new Response('<!doctype html>', {
                      headers: { 'Content-Type': 'text/html; charset=utf-8' },
                  })
                : new Response('Not found', { status: 404 });
        });

        const response = await serveAssetOrAppShell(
            new Request('https://stor.example/calendar', {
                headers: { Accept: 'text/html,application/xhtml+xml' },
            }),
            { ASSETS: { fetch } } as never,
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('<!doctype html>');
        expect(
            fetch.mock.calls.map(([request]) => new URL(request.url).pathname),
        ).toEqual(['/calendar', '/index.html']);
    });

    it('never turns a missing immutable module into HTML', async () => {
        const missing = new Response('Not found', { status: 404 });
        const fetch = vi.fn(async () => missing);

        const response = await serveAssetOrAppShell(
            new Request('https://stor.example/_app/immutable/chunks/stale.js', {
                headers: { Accept: 'text/html,application/xhtml+xml' },
            }),
            { ASSETS: { fetch } } as never,
        );

        expect(response).toBe(missing);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('preserves 404 responses for non-navigation requests', async () => {
        const missing = new Response('Not found', { status: 404 });
        const fetch = vi.fn(async () => missing);

        const response = await serveAssetOrAppShell(
            new Request('https://stor.example/missing.json', {
                headers: { Accept: 'application/json' },
            }),
            { ASSETS: { fetch } } as never,
        );

        expect(response).toBe(missing);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('preserves 404 responses for file-like browser navigations', async () => {
        const missing = new Response('Not found', { status: 404 });
        const fetch = vi.fn(async () => missing);

        const response = await serveAssetOrAppShell(
            new Request('https://stor.example/icons/missing.svg', {
                headers: { Accept: 'text/html,application/xhtml+xml' },
            }),
            { ASSETS: { fetch } } as never,
        );

        expect(response).toBe(missing);
        expect(fetch).toHaveBeenCalledOnce();
    });
});

function adminEnv(fetch: ReturnType<typeof vi.fn>) {
    return {
        CF_ACCESS_ADMIN_AUD: 'admin-audience',
        CF_ACCESS_TEAM_DOMAIN: 'https://stor.cloudflareaccess.com',
        LEDGER: {
            fetch: fetch as (request: Request) => Promise<Response>,
        },
        LEDGER_ADMIN_EMAIL: 'owner@example.com',
        LEDGER_ADMIN_TOKEN: 'ledger-admin-secret',
        STOR_ADMIN_ENABLED: 'true',
    };
}
