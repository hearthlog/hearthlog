/**
 * Which refresh keys (`app:stash`, `app:finance`, ...) the runtime just invalidated, for readers outside SvelteKit's
 * load functions: the native engine forwards them to its app as `native:changed`. Every place that invalidates page
 * data by key also announces it here.
 */

type Listener = (keys: readonly string[]) => void;

const listeners = new Set<Listener>();

export function announceInvalidation(keys: readonly string[]): void {
    if (keys.length === 0) return;
    for (const listener of listeners) {
        try {
            listener(keys);
        } catch (error) {
            console.warn('[Invalidation] A listener failed', error);
        }
    }
}

export function onInvalidation(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
