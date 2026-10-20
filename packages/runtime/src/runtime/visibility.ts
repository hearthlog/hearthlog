/**
 * Whether the page counts as in front of the person: the tab is visible in a browser, or the
 * native app says so for its hidden engine page (`../native/engine.svelte.ts`). Sync, realtime and
 * the Access probe run only while it is. A browser never sets the override, so there it is
 * exactly `document.visibilityState`.
 */

export const PAGE_VISIBILITY_EVENT = 'stor:page-visibility';

let override: boolean | null = null;

export function pageVisible(): boolean {
    if (override !== null) return override;
    return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** `null` returns to the document's own visibility. */
export function setPageVisibilityOverride(visible: boolean | null): void {
    const before = pageVisible();
    override = visible;
    if (typeof window !== 'undefined' && pageVisible() !== before) {
        window.dispatchEvent(new CustomEvent(PAGE_VISIBILITY_EVENT));
    }
}

/** Calls `handler` when `pageVisible()` may have changed: the document's own event or the override. */
export function onPageVisibilityChange(handler: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = () => handler();
    document.addEventListener('visibilitychange', listener);
    window.addEventListener(PAGE_VISIBILITY_EVENT, listener);
    return () => {
        document.removeEventListener('visibilitychange', listener);
        window.removeEventListener(PAGE_VISIBILITY_EVENT, listener);
    };
}
