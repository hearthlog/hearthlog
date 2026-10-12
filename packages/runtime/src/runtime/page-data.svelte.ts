import type { LoadEvent } from '@sveltejs/kit';
import { get } from 'svelte/store';
import { workspaceReadiness } from '@hearthlog/ui/state/readiness.js';
import { recordTiming, measurementMetadata, getNavigationTiming } from '../utils/perf.js';
import type { WorkspaceTicket } from './workspace.js';

type RouteEvent = Pick<LoadEvent, 'url' | 'params' | 'depends' | 'parent'>;
export type PagePublisher<T> = (update: Partial<T>, region?: string) => void;
type Measurement = { id: string; navigationId: string; kind: 'startup' | 'navigation' | 'refresh'; start: number; finish: () => void };
const pendingRenders = new Set<Promise<void>>();
let activeResource: PageResource<any> | undefined;
let hasRenderedPage = false;

export class PageResource<T> {
    value = $state.raw<T>();
    error = $state.raw<unknown>(null);
    pending = $state(true);
    revision = $state(0);
    scope = $state('');
    promise!: Promise<T>;
    measurement = $state.raw<Measurement>(undefined!);
    #request = 0;
    #recordedMeasurement = '';
    #readiness = $state(get(workspaceReadiness));
    #unsubscribe?: () => void;
    #partial = $state.raw<Partial<T>>({});
    #partialScope = $state('');
    #regions = $state.raw(new Set<string>());

    constructor(public key: string, readonly route: string, readonly initial: T, readonly requiresWorkspace = true) {}

    get usable(): boolean {
        return this.value !== undefined && (!this.requiresWorkspace || (this.#readiness.ready && this.scope === this.#readiness.key));
    }
    get data(): T {
        if (this.usable) return this.value!;
        return this.#readiness.ready && this.#partialScope === this.#readiness.key
            ? { ...this.initial, ...this.#partial } : this.initial;
    }
    get loading(): boolean { return !this.usable; }
    get refreshing(): boolean { return this.usable && this.pending; }
    isRegionLoading(region: string): boolean {
        return !this.usable && !(this.#readiness.ready && this.#partialScope === this.#readiness.key && this.#regions.has(region));
    }

    attach(): () => void {
        this.#unsubscribe?.();
        this.#unsubscribe = workspaceReadiness.subscribe((state) => this.#readiness = state);
        return () => {
            this.#unsubscribe?.();
            this.measurement.finish();
        };
    }

    load(callback: (publish: PagePublisher<T>) => Promise<T>): void {
        const request = ++this.#request;
        this.measurement?.finish();
        let finish!: () => void;
        const rendered = new Promise<void>((resolve) => finish = resolve);
        pendingRenders.add(rendered);
        void rendered.then(() => pendingRenders.delete(rendered));
        const navigation = getNavigationTiming();
        const kind = this.value !== undefined ? 'refresh' : navigation.start || hasRenderedPage ? 'navigation' : 'startup';
        this.measurement = {
            id: crypto.randomUUID(),
            navigationId: navigation.id,
            kind,
            start: kind === 'startup' ? 0 : kind === 'navigation' ? navigation.start || performance.now() : performance.now(),
            finish,
        };
        this.pending = true;
        this.error = null;
        this.#partial = {};
        this.#regions = new Set();
        this.promise = callback((update, region) => {
            if (request !== this.#request || activeResource !== this) return;
            this.#partialScope = get(workspaceReadiness).key;
            this.#partial = { ...this.#partial, ...update };
            if (region) this.#regions = new Set([...this.#regions, region]);
        }).then((value) => {
            if (request !== this.#request || activeResource !== this) return value;
            this.scope = get(workspaceReadiness).key;
            if (this.requiresWorkspace) this.key = `${this.scope}:${this.route}`;
            this.value = value;
            this.pending = false;
            this.revision += 1;
            return value;
        }).catch((error) => {
            if (request === this.#request) {
                this.error = error;
                this.pending = false;
                finish();
            }
            throw error;
        });
        void this.promise.catch(() => undefined);
    }

    rendered(measurement: Measurement): void {
        if (measurement !== this.measurement || this.pending || !this.usable || this.error || this.#recordedMeasurement === measurement.id) return;
        this.#recordedMeasurement = measurement.id;
        recordTiming(measurement.kind === 'startup' ? 'startup' : 'ui', 'pageContentReady', performance.now() - measurement.start, {
            ...measurementMetadata(), baselineMetric: 'pageContentReady', route: this.route,
            navigationId: measurement.navigationId, loadId: measurement.id, kind: measurement.kind, outcome: 'success',
        });
        hasRenderedPage = true;
        measurement.finish();
    }
}

/** Load functions finish immediately; only their resource waits for local data. */
export function deferPage<T>(event: RouteEvent, initial: NoInfer<T>, loader: (publish: PagePublisher<NoInfer<T>>) => Promise<T>): { pageResource: PageResource<T> } {
    // Snapshot tracked URL properties before deferring work. Action-only queries
    // must not discard a loaded page or an open drawer.
    const url = new URL(event.url.href);
    for (const key of [...url.searchParams.keys()]) {
        if (key.startsWith('new')) url.searchParams.delete(key);
    }
    const route = `${url.pathname}${url.search}`;
    const key = `${get(workspaceReadiness).key}:${route}`;
    if (activeResource?.key !== key) {
        activeResource?.measurement.finish();
        activeResource = new PageResource<T>(key, route, initial);
    }
    const resource = activeResource as PageResource<T>;
    // parent() itself is immediate; never await the parent's deferred payload
    // before returning from a load function.
    const parent = event.parent() as Promise<{ workspace: WorkspaceTicket }>;
    resource.load(async (publish) => {
        const data = await parent;
        await data.workspace.ready;
        const scope = get(workspaceReadiness).key;
        const result = await loader((update, region) => {
            if (scope === get(workspaceReadiness).key) publish(update, region);
        });
        if (scope !== get(workspaceReadiness).key) throw new DOMException('Workspace changed', 'AbortError');
        return result;
    });
    return { pageResource: resource };
}

/** Wait for data AND its visible consumer, rather than merely invalidate(). */
export async function waitForPageUpdates(): Promise<void> {
    while (pendingRenders.size) await Promise.all([...pendingRenders]);
    if (activeResource?.error) throw activeResource.error;
}

export { providePageResource } from '@hearthlog/ui/state/page-context.js';

export function deferLocalPage<T>(url: URL, initial: NoInfer<T>, loader: () => Promise<T>): { pageResource: PageResource<T> } {
    const route = `${url.pathname}${url.search}`;
    const key = `local:${route}`;
    if (activeResource?.key !== key) {
        activeResource?.measurement.finish();
        activeResource = new PageResource<T>(key, route, initial, false);
    }
    const resource = activeResource as PageResource<T>;
    resource.load(loader);
    return { pageResource: resource };
}
