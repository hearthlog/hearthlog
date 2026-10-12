// Svelte-native signal for notifying when events data change
// Export a $state object and mutate its property (reassignment of exported $state is not allowed)
export let events = $state({ updatedAt: 0, refreshRequiredAt: 0 });

export function notifyEventsChanged(options: { routesInvalidated?: boolean } = {}) {
    // Several changes can finish in the same millisecond.
    events.updatedAt = Math.max(Date.now(), events.updatedAt + 1);
    // Badges and file consumers still hear about changes whose route data was
    // refreshed by sync. Only unhandled changes ask a page to refresh itself.
    if (!options.routesInvalidated) events.refreshRequiredAt = events.updatedAt;
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('stor:events-changed'));
    }
}
