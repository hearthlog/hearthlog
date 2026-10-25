/** One in-flight step per operation (alarm and callers share it), with a bounded wait for HTTP/RPC callers.
 * Losing a response must not enqueue another copy of the same running step.
 */
export class MaintenanceSteps<T> {
    private queue: Promise<unknown> = Promise.resolve();
    private readonly running = new Map<string, Promise<T>>();

    constructor(private readonly keepAlive: (work: Promise<unknown>) => void, private readonly responseWaitMs = 1000) {}

    /** Queue one step behind earlier ones (or join the identical step already in flight) and resolve with its real result. */
    run(key: string, work: () => Promise<T>): Promise<T> {
        let run = this.running.get(key);
        if (!run) {
            run = this.queue.then(work);
            this.running.set(key, run);
            const settled = run.then(() => undefined, () => undefined).then(() => {
                this.running.delete(key);
            });
            this.queue = settled;
            this.keepAlive(settled);
        }
        return run;
    }

    async advance(key: string, work: () => Promise<T>, current: () => T): Promise<T> {
        const run = this.run(key, work);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([run, new Promise<T>((resolve, reject) => {
                timer = setTimeout(() => {
                    try { resolve(current()); } catch (cause) { reject(cause); }
                }, this.responseWaitMs);
            })]);
        } finally {
            clearTimeout(timer);
        }
    }
}
