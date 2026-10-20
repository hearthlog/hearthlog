/** Stands in for the `cloudflare:workers` runtime module when Vitest loads Worker code under Node. */
export class WorkerEntrypoint<Env = unknown> {
    constructor(
        readonly ctx: unknown,
        readonly env: Env,
    ) {}
}

export class DurableObject<Env = unknown> {
    constructor(readonly ctx: DurableObjectState, readonly env: Env) {}
}
