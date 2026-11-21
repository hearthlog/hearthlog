import { describe, expect, it, vi } from 'vitest';
import { GATEWAY_CRONS, MAX_INBOUND_EMAIL_BYTES, type ServerModule } from '@hearthlog/contracts';
import { deterministicUuid } from '@hearthlog/contracts/integrations/ids';
import { handleIntegrationRequest, type IntegrationsEnv } from './index';
import { handleInboundEmail, recipientIntegrationId, runServerJobs, type EmailMessageLike, type ServerJobsEnv } from './server';

// The development site installs no module, so the test module's kind is added to the generated catalog here.
vi.mock('../../../../dev/.generated/src/modules.generated.ts', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    MODULE_INTEGRATION_KINDS: [{ kind: 'bank-test', feature: 'finance' }],
}));

const LOG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = Date.UTC(2026, 10, 21, 9, 17);

interface SentEvent { id: string; type: string; entityId: string; baseEntityVersion?: number; payload: Record<string, unknown> }

/** A Ledger that keeps the version chain and idempotency the real one enforces, and records who wrote what. */
function ledger() {
    const versions = new Map<string, number>();
    const answered = new Set<string>();
    const appends: Array<{ path: string; actor: string | null; events: SentEvent[] }> = [];
    return {
        appends,
        versions,
        fetch: async (request: Request) => {
            const body = await request.json() as { requestId: string; events: SentEvent[] };
            if (answered.has(body.requestId)) return Response.json({ replayed: true });
            const [event] = body.events;
            const live = versions.get(event!.entityId);
            if (live !== undefined && event!.baseEntityVersion !== live) {
                return Response.json({ code: 'invalid_entity_version_chain', expectedBaseEntityVersion: live }, { status: 409 });
            }
            versions.set(event!.entityId, (live ?? 0) + 1);
            answered.add(body.requestId);
            appends.push({ path: new URL(request.url).pathname, actor: request.headers.get('X-Ledger-Actor'), events: body.events });
            return Response.json({ newVersion: (live ?? 0) + 1 });
        },
    };
}

function env(fake = ledger(), integrations: unknown[] = [{ id: 'bank-mail', kind: 'bank-test', logId: LOG }]): ServerJobsEnv & { fake: ReturnType<typeof ledger> } {
    return { LEDGER: fake, LEDGER_AUTH_TOKEN: 'token', INTEGRATIONS: JSON.stringify(integrations), fake };
}

/** Writes one note per call: from the hourly job (the sync) and from each message (the notification). */
const testModule: ServerModule<Env> = {
    id: 'bank-test',
    routes: [],
    async hourly(_env, context) {
        for (const integration of context.integrations) {
            const entityId = `bank_note:${await deterministicUuid(integration.id, 'sync')}`;
            await integration.upsertEntity(async (base) => ({
                requestId: await deterministicUuid(entityId, String(base ?? 'new'), String(context.now)),
                events: [{
                    id: await deterministicUuid(entityId, 'event', String(base ?? 'new'), String(context.now)),
                    type: base === undefined ? 'BANK_NOTE_ADDED' : 'BANK_NOTE_UPDATED',
                    entityId,
                    timestamp: context.now,
                    ...(base === undefined ? {} : { baseEntityVersion: base }),
                    payload: { text: 'synced', at: context.now },
                }],
            }));
        }
    },
    email: {
        async 'bank-test'({ integration, email, now, reject }) {
            const text = new TextDecoder().decode(email.raw);
            const subject = /^Subject: (.*)$/m.exec(text)?.[1];
            if (!subject) return reject('Not a bank notification');
            const entityId = `bank_note:${await deterministicUuid(integration.id, 'mail', subject)}`;
            await integration.upsertEntity(async () => ({
                requestId: await deterministicUuid(entityId, 'request'),
                events: [{ id: await deterministicUuid(entityId, 'event'), type: 'BANK_NOTE_ADDED', entityId, timestamp: now, payload: { text: subject } }],
            }));
        },
    },
};

function message(to: string, raw: string, size?: number): EmailMessageLike & { rejected: string | null } {
    const bytes = new TextEncoder().encode(raw);
    return {
        from: 'notifications@bank.example',
        to,
        headers: new Headers({ Subject: 'x' }),
        raw: new Blob([bytes]).stream(),
        rawSize: size ?? bytes.byteLength,
        rejected: null,
        setReject(reason) { this.rejected = reason; },
    };
}

describe('server jobs', () => {
    it('hands the hourly job its integrations, writing to their log as the integration', async () => {
        const config = env();
        await runServerJobs(config, [testModule], GATEWAY_CRONS.hourly, NOW);
        await runServerJobs(config, [testModule], GATEWAY_CRONS.hourly, NOW + 3_600_000);

        expect(config.fake.appends.map((append) => append.events[0]!.type)).toEqual(['BANK_NOTE_ADDED', 'BANK_NOTE_UPDATED']);
        expect(config.fake.appends.every((append) => append.actor === 'service:bank-mail' && append.path === `/logs/${LOG}/events`)).toBe(true);
        expect(config.fake.appends[1]!.events[0]).toMatchObject({ baseEntityVersion: 1, payload: { text: 'synced' } });
    });

    it('runs the daily job on the daily trigger and the hourly one only on the hourly trigger', async () => {
        const daily = vi.fn(async () => {});
        const hourly = vi.fn(async () => {});
        const module: ServerModule<Env> = { id: 'jobs', routes: [], scheduled: daily, hourly };
        await runServerJobs(env(), [module], GATEWAY_CRONS.daily, NOW);
        expect([daily.mock.calls.length, hourly.mock.calls.length]).toEqual([1, 0]);
        await runServerJobs(env(), [module], GATEWAY_CRONS.hourly, NOW);
        expect([daily.mock.calls.length, hourly.mock.calls.length]).toEqual([1, 1]);
    });

    it('gives a module only the integrations of its own kinds', async () => {
        const seen: string[][] = [];
        const other: ServerModule<Env> = { id: 'other', routes: [], hourly: async (_env, context) => { seen.push(context.integrations.map((entry) => entry.id)); } };
        await runServerJobs(env(), [other], GATEWAY_CRONS.hourly, NOW);
        expect(seen).toEqual([[]]);
    });

    it('runs every job when one fails, then fails the run', async () => {
        const after = vi.fn(async () => {});
        const failing: ServerModule<Env> = { id: 'failing', routes: [], hourly: async () => { throw new Error('boom'); } };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(runServerJobs(env(), [failing, { id: 'after', routes: [], hourly: after }], GATEWAY_CRONS.hourly, NOW)).rejects.toThrow('boom');
        expect(after).toHaveBeenCalledOnce();
        error.mockRestore();
    });
});

describe('inbound email', () => {
    it('names the integration by the local part, without a tag', () => {
        expect(recipientIntegrationId('bank-mail@in.example.cz')).toBe('bank-mail');
        expect(recipientIntegrationId('Bank-Mail+csob@in.example.cz')).toBe('bank-mail');
        expect(recipientIntegrationId('not valid@in.example.cz')).toBeNull();
        expect(recipientIntegrationId('nobody')).toBeNull();
    });

    it('lets the owning module write one entity per message, once even when the message comes twice', async () => {
        const config = env();
        const mail = 'From: notifications@bank.example\r\nSubject: Payment 1 284 CZK\r\n\r\nbody';
        const first = message('bank-mail+csob@in.example.cz', mail);
        await handleInboundEmail(first, config, [testModule], NOW);
        await handleInboundEmail(message('bank-mail@in.example.cz', mail), config, [testModule], NOW);

        expect(first.rejected).toBeNull();
        expect(config.fake.appends).toHaveLength(1);
        expect(config.fake.appends[0]).toMatchObject({ actor: 'service:bank-mail', path: `/logs/${LOG}/events` });
        expect(config.fake.appends[0]!.events[0]!.payload).toEqual({ text: 'Payment 1 284 CZK' });
    });

    it('bounces mail for an unknown integration, a kind without an email handler, or one too large', async () => {
        const unknown = message('someone@in.example.cz', 'Subject: hi\r\n\r\n');
        await handleInboundEmail(unknown, env(), [testModule], NOW);
        expect(unknown.rejected).toBe('Unknown recipient');

        const noHandler = message('bank-mail@in.example.cz', 'Subject: hi\r\n\r\n');
        await handleInboundEmail(noHandler, env(), [{ id: 'other', routes: [] }], NOW);
        expect(noHandler.rejected).toBe('Unknown recipient');

        const large = message('bank-mail@in.example.cz', 'Subject: hi\r\n\r\n', MAX_INBOUND_EMAIL_BYTES + 1);
        const config = env();
        await handleInboundEmail(large, config, [testModule], NOW);
        expect(large.rejected).toBe('The message is too large');
        expect(config.fake.appends).toHaveLength(0);
    });

    it('passes on the handler’s own refusal, and refuses when the handler fails', async () => {
        const refused = message('bank-mail@in.example.cz', 'no headers at all');
        await handleInboundEmail(refused, env(), [testModule], NOW);
        expect(refused.rejected).toBe('Not a bank notification');

        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const broken = message('bank-mail@in.example.cz', 'Subject: hi\r\n\r\n');
        await handleInboundEmail(broken, env({ fetch: async () => { throw new Error('down'); } } as never), [testModule], NOW);
        expect(broken.rejected).toBe('The message could not be processed');
        error.mockRestore();
    });
});

describe('inbound requests', () => {
    it('still need a service token: an integration without a client id accepts none', async () => {
        const config = { ...env(), CF_ACCESS_INTEGRATIONS_AUD: 'aud', CF_ACCESS_TEAM_DOMAIN: 'https://team.example' } as unknown as IntegrationsEnv;
        const request = new Request('https://stor.example/api/integrations/v1/bank-mail/bank-test/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const response = await handleIntegrationRequest(request, config, [testModule], async () => ({ clientId: 'abcdef0123456789abcdef.access' }), () => NOW);
        expect(response.status).toBe(404);
    });
});
