/** One in-flight step per operation, with a bounded wait for HTTP/RPC callers.
 * Losing a response must not enqueue another copy of the same running step.
 */
export class MaintenanceSteps<T> {
    private queue: Promise<unknown> = Promise.resolve();
    private readonly running = new Map<string, Promise<T>>();

    constructor(private readonly keepAlive: (work: Promise<unknown>) => void, private readonly responseWaitMs = 1000) {}

    async advance(key: string, work: () => Promise<T>, current: () => T): Promise<T> {
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
