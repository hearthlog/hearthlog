/**
 * Server code that writes outside an inbound request: the modules' cron jobs and the mail Email Routing delivers.
 *
 * Both write through a configured integration (tenant config: an id, a kind, one log), exactly like an inbound
 * integration: the module builds the events, the host appends them with the app token it already holds, and the
 * author is `service:<integration id>`. Neither needs a service token; nothing is stored between calls.
 */

import {
    GATEWAY_CRONS,
    MAX_INBOUND_EMAIL_BYTES,
    type EmailHandler,
    type ServerIntegration,
    type ServerJobContext,
    type ServerModule,
} from "@hearthlog/contracts";
import { INTEGRATION_ID_PATTERN, parseConfiguredIntegrations, type IntegrationDefinition } from "@hearthlog/contracts/integrations/kinds";
import { upsertEntity, type AppendEnv } from "./append";

export type ServerJobsEnv = AppendEnv & { INTEGRATIONS?: string };

/** The parts of Cloudflare's `ForwardableEmailMessage` the host reads. */
export interface EmailMessageLike {
    readonly from: string;
    readonly to: string;
    readonly headers: Headers;
    readonly raw: ReadableStream<Uint8Array>;
    readonly rawSize: number;
    setReject(reason: string): void;
}

function serverIntegration(env: ServerJobsEnv, integration: IntegrationDefinition): ServerIntegration {
    return {
        id: integration.id,
        kind: integration.kind,
        logId: integration.logId,
        upsertEntity: (build) => upsertEntity(env, { logId: integration.logId, actor: `service:${integration.id}`, build }),
    };
}

/** The kinds a module implements: the ones it has an inbound or email handler for. */
function kindsOf(module: ServerModule<Env>): Set<string> {
    return new Set([...Object.keys(module.integrations ?? {}), ...Object.keys(module.email ?? {})]);
}

/**
 * Run the jobs one cron trigger stands for: the hourly trigger runs `hourly`, any other runs the daily `scheduled`.
 * One module's failure does not stop the others; the run fails afterwards, so Cloudflare records it.
 */
export async function runServerJobs(
    env: ServerJobsEnv,
    modules: ReadonlyArray<ServerModule<Env>>,
    cron: string,
    now: number = Date.now(),
): Promise<void> {
    const hourly = cron === GATEWAY_CRONS.hourly;
    const configured = parseConfiguredIntegrations(env.INTEGRATIONS);
    const failures: unknown[] = [];
    for (const module of modules) {
        const job = hourly ? module.hourly : module.scheduled;
        if (!job) continue;
        const kinds = kindsOf(module);
        const context: ServerJobContext = {
            now,
            integrations: configured.filter((integration) => kinds.has(integration.kind)).map((integration) => serverIntegration(env, integration)),
        };
        try {
            await job.call(module, env as unknown as Env, context);
        } catch (error) {
            console.error(`hearthlog: the ${hourly ? "hourly" : "daily"} job of ${module.id} failed`, error);
            failures.push(error);
        }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Several server jobs failed");
}

/** The integration id a recipient names: the local part, without a `+tag`. */
export function recipientIntegrationId(to: string): string | null {
    const at = to.lastIndexOf("@");
    if (at <= 0) return null;
    const id = to.slice(0, at).split("+", 1)[0]!.toLowerCase();
    return INTEGRATION_ID_PATTERN.test(id) ? id : null;
}

/**
 * Hand one delivered message to the module that owns the recipient integration's kind. A message nobody can take
 * is refused (Email Routing bounces it); the handler decides about everything else, including whether to trust it.
 */
export async function handleInboundEmail(
    message: EmailMessageLike,
    env: ServerJobsEnv,
    modules: ReadonlyArray<ServerModule<Env>>,
    now: number = Date.now(),
): Promise<void> {
    const id = recipientIntegrationId(message.to);
    const integration = id ? parseConfiguredIntegrations(env.INTEGRATIONS).find((candidate) => candidate.id === id) : undefined;
    let handler: EmailHandler<Env> | undefined;
    for (const module of modules) {
        handler ??= integration ? module.email?.[integration.kind] : undefined;
    }
    if (!integration || !handler) {
        message.setReject("Unknown recipient");
        return;
    }
    if (!env.LEDGER_AUTH_TOKEN) {
        message.setReject("This address is not configured");
        return;
    }
    if (message.rawSize > MAX_INBOUND_EMAIL_BYTES) {
        message.setReject("The message is too large");
        return;
    }
    const raw = await readCapped(message.raw, MAX_INBOUND_EMAIL_BYTES);
    if (!raw) {
        message.setReject("The message is too large");
        return;
    }
    let rejected = false;
    try {
        await handler({
            env: env as unknown as Env,
            integration: serverIntegration(env, integration),
            email: { from: message.from, to: message.to, headers: message.headers, raw },
            now,
            reject: (reason) => {
                rejected = true;
                message.setReject(reason);
            },
        });
    } catch (error) {
        console.error(`hearthlog: the email handler of ${integration.id} failed`, error);
        if (!rejected) message.setReject("The message could not be processed");
    }
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
