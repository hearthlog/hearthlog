const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The hint drawn on a sheet's primary action, in the platform's own words. */
export const submitHint = apple ? '⌘↵' : 'Ctrl ↵';

/** A footer's primary action: one marked `data-stor-primary`, else its last primary-variant button. */
function primaryIn(footer: HTMLElement): HTMLButtonElement | null {
    const marked = footer.querySelector<HTMLButtonElement>('button[data-stor-primary]');
    if (marked) return marked;
    const primaries = footer.querySelectorAll<HTMLButtonElement>('button[data-stor-button-variant="default"]');
    return primaries[primaries.length - 1] ?? null;
}

/**
 * ⌘↵ (Ctrl+Enter elsewhere) presses a sheet's primary action, wherever focus is inside the sheet.
 *
 * Attach to the footer that holds the action: it marks that button with the hint (`data-stor-shortcut`, drawn
 * by recipes.css) and listens on the dialog around the footer, so only the sheet in front answers.
 */
export function primaryShortcut(footer: HTMLElement): () => void {
    const dialog = footer.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? footer;
    let marked: HTMLButtonElement | null = null;

    const unmark = () => {
        if (!marked) return;
        delete marked.dataset.storShortcut;
        marked.removeAttribute('aria-keyshortcuts');
        marked = null;
    };
    const mark = () => {
        const next = primaryIn(footer);
        if (next === marked) return;
        unmark();
        if (!next) return;
        next.dataset.storShortcut = submitHint;
        next.setAttribute('aria-keyshortcuts', apple ? 'Meta+Enter' : 'Control+Enter');
        marked = next;
    };
    const press = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing || event.defaultPrevented) return;
        const button = primaryIn(footer);
        if (!button || button.disabled) return;
        event.preventDefault();
        button.click();
    };

    mark();
    const observer = new MutationObserver(mark);
    observer.observe(footer, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-stor-button-variant', 'data-stor-primary'] });
    dialog.addEventListener('keydown', press);
    return () => {
        observer.disconnect();
        dialog.removeEventListener('keydown', press);
        unmark();
    };
}
