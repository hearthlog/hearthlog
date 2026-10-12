/**
 * The gateway's side of a tenant move's write fence.
 *
 * The Ledger refuses writes to a fenced application itself. The gateway has its
 * own writes: files, publications, feed registrations, integration ingest and
 * the daily jobs. While the application is fenced they stop too, or a photo
 * uploaded mid-move would land in a bucket the copy has already read. The
 * answer is the same as the Ledger's: 503 with `Retry-After` while the move
 * runs, which the clients already retry, and 410 with the destination once it
 * has finished.
 */

export interface GatewayFence {
    mode: "tenant_migrating" | "moved";
    destination: string | null;
}

export interface FenceEnv {
    LEDGER: Env["LEDGER"];
    LEDGER_AUTH_TOKEN: Env["LEDGER_AUTH_TOKEN"];
}

const RETRY_AFTER_SECONDS = 30;
/** A move is minutes long; a few seconds of staleness only shifts when the pause starts. */
const CACHE_MS = 5_000;
const cache = new WeakMap<object, { at: number; fence: GatewayFence | null }>();

/**
 * Whether the application is fenced. If the Ledger cannot be asked, the answer
 * is "not fenced": the Ledger enforces its own writes, and refusing everything
 * because a status call failed would turn a blip into an outage.
 */
export async function readFence(env: FenceEnv, now = Date.now()): Promise<GatewayFence | null> {
    const cached = cache.get(env.LEDGER);
    if (cached && now - cached.at < CACHE_MS) return cached.fence;
    let fence: GatewayFence | null = null;
    try {
        const response = await env.LEDGER.fetch(
            new Request("https://ledger.internal/session", { headers: { Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}` } }),
        );
        if (response.ok) {
            const session = (await response.json()) as { fence?: { mode?: unknown; destination?: unknown } };
            const mode = session.fence?.mode;
            if (mode === "tenant_migrating" || mode === "moved") {
                fence = { mode, destination: typeof session.fence?.destination === "string" ? session.fence.destination : null };
            }
        } else if (response.status === 410) {
            // A moved application's token may stop working at the source; that too is the fence.
            fence = { mode: "moved", destination: null };
        }
    } catch {
        return null;
    }
    cache.set(env.LEDGER, { at: now, fence });
    return fence;
}

export function fenceResponse(fence: GatewayFence): Response {
    if (fence.mode === "tenant_migrating") {
        return Response.json(
            { error: "Unavailable", code: "tenant_migrating", message: "This workspace is being moved; writes resume shortly", retryAfterSeconds: RETRY_AFTER_SECONDS },
            { status: 503, headers: { "Retry-After": String(RETRY_AFTER_SECONDS), "Cache-Control": "no-store" } },
        );
    }
    return Response.json(
        { error: "Gone", code: "tenant_moved", message: "This workspace has moved", ...(fence.destination ? { destination: fence.destination } : {}) },
        { status: 410, headers: { "Cache-Control": "no-store" } },
    );
}

export function isWrite(request: Request): boolean {
    return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

/** The refusal for a write while fenced, or null. Reads are never refused. */
export async function fencedWrite(request: Request, env: FenceEnv): Promise<Response | null> {
    if (!isWrite(request)) return null;
    const fence = await readFence(env);
    return fence ? fenceResponse(fence) : null;
}
