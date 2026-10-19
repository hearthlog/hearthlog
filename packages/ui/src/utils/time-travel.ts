/**
 * Time travel: a month or day change moves the page's content 16px against the direction of time while it
 * cross-fades (the View Transitions API; styles in recipes.css). Without the API, or under reduced motion, the
 * change just happens.
 */
export function timeTravel(direction: -1 | 1, update: () => void | Promise<void>): void | Promise<void> {
    const start = typeof document !== 'undefined' ? document.startViewTransition?.bind(document) : undefined;
    if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
    const root = document.documentElement;
    root.dataset.timeDirection = direction > 0 ? 'forward' : 'back';
    const transition = start(async () => {
        await update();
    });
    const clear = () => delete root.dataset.timeDirection;
    void transition.finished.then(clear, clear);
}
