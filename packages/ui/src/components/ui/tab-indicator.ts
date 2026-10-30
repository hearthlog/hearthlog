const SELECTED_TAB =
    '[data-state="active"], [aria-selected="true"], [aria-current="page"], [aria-current="true"]';

/**
 * Sliding selection pill for a tab row.
 *
 * Measures the selected trigger and animates a pill between tabs. The selected
 * trigger keeps its own background until the pill is positioned, so the row
 * never flashes unselected while the list is still laying out.
 *
 * Usage: `{@attach tabIndicator}` on a `.stor-page-tabs` row or a Bits UI
 * `Tabs.List`. Motion is disabled by the global reduced-motion rule.
 */
export function tabIndicator(list: HTMLElement): () => void {
    const pill = document.createElement('span');
    pill.className = 'stor-tab-indicator';
    pill.setAttribute('aria-hidden', 'true');
    pill.setAttribute('role', 'presentation');
    list.insertBefore(pill, list.firstChild);

    let frame = 0;
    let destroyed = false;

    const place = (): boolean => {
        const selected = list.querySelector<HTMLElement>(SELECTED_TAB);
        if (!selected) return false;
        const listRect = list.getBoundingClientRect();
        const selectedRect = selected.getBoundingClientRect();
        if (selectedRect.width === 0) return false;
        pill.style.setProperty(
            '--stor-tab-x',
            `${selectedRect.left - listRect.left + list.scrollLeft - list.clientLeft}px`,
        );
        pill.style.setProperty('--stor-tab-w', `${selectedRect.width}px`);
        return true;
    };

    const update = (): void => {
        if (!place()) {
            list.classList.remove('stor-tabs-sliding');
            return;
        }
        list.classList.add('stor-tabs-sliding');
        // The first placement lands without motion; only later moves slide. Animating it would grow the pill from
        // zero width over the tab's own face, which fades out at the same time, so every load showed two pills.
        if (!list.classList.contains('stor-tabs-ready')) {
            requestAnimationFrame(() => {
                if (!destroyed) list.classList.add('stor-tabs-ready');
            });
        }
    };

    const schedule = (): void => {
        if (destroyed) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
    };

    const sizes = new ResizeObserver(schedule);
    const observeTabs = (): void => {
        sizes.disconnect();
        sizes.observe(list);
        for (const child of list.children) {
            if (child !== pill) sizes.observe(child);
        }
    };

    const mutations = new MutationObserver(() => {
        observeTabs();
        update();
    });
    mutations.observe(list, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['data-state', 'aria-selected', 'aria-current'],
    });

    observeTabs();
    update();
    void document.fonts.ready.then(schedule);

    return () => {
        destroyed = true;
        cancelAnimationFrame(frame);
        sizes.disconnect();
        mutations.disconnect();
        pill.remove();
        list.classList.remove('stor-tabs-sliding', 'stor-tabs-ready');
    };
}
