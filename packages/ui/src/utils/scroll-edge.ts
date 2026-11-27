export interface ScrollEdgeOptions {
    /**
     * `scrolled`: the scroller has moved past `threshold`. `stuck`: the node, a `position: sticky` element, sits at
     * its sticky offset because the scroller has moved under it.
     */
    edge?: 'scrolled' | 'stuck';
    /** Pixels of scroll that count as scrolled (`scrolled` only). Default 24. */
    threshold?: number;
    /** The element that scrolls. Default: the nearest `[data-stor-scroller]` or `[data-stor-main]` around the node, the node included. */
    scroller?: HTMLElement | null;
    /** Called with the new state whenever it changes, and with `false` when the attachment goes away. */
    onChange?: (active: boolean) => void;
}

/**
 * Tells chrome when content has scrolled under it, so it can turn to glass only when there is something beneath.
 * Sets `data-scrolled` (or `data-stuck`) on the node and reports changes through `onChange`. One passive scroll
 * listener and at most one read per frame.
 *
 * Usage: `{@attach scrollEdge({ onChange: (value) => (scrolled = value) })}`.
 */
export function scrollEdge(options: ScrollEdgeOptions = {}): (node: HTMLElement) => () => void {
    const edge = options.edge ?? 'scrolled';
    const threshold = options.threshold ?? 24;
    const attribute = edge === 'stuck' ? 'data-stuck' : 'data-scrolled';
    return (node) => {
        const scroller = options.scroller ?? node.closest<HTMLElement>('[data-stor-scroller], [data-stor-main]');
        if (!scroller) return () => {};
        let active = false;
        let frame = 0;

        const measure = (): boolean => {
            if (edge === 'scrolled') return scroller.scrollTop > threshold;
            if (scroller.scrollTop <= 0) return false;
            const style = getComputedStyle(node);
            if (style.position !== 'sticky') return false;
            const offset = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop;
            return offset <= parseFloat(style.top) + 0.5;
        };
        const read = (): void => {
            frame = 0;
            const next = measure();
            if (next === active) return;
            active = next;
            node.toggleAttribute(attribute, active);
            options.onChange?.(active);
        };
        const schedule = (): void => {
            if (!frame) frame = requestAnimationFrame(read);
        };

        scroller.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule, { passive: true });
        read();
        return () => {
            cancelAnimationFrame(frame);
            scroller.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            node.removeAttribute(attribute);
            if (active) options.onChange?.(false);
        };
    };
}
