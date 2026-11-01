function storageKey(siteId: string): string {
    return `stor:nsfw-shown:${siteId}`;
}

/**
 * Whether the navigation lists the NSFW sections. Shown for this tab's session only (session storage), so a new
 * window or app launch starts hidden again. Advisory: blocked storage just keeps the choice in memory.
 */
class NsfwToggle {
    shown = $state(false);
    #key: string | null = null;

    open(siteId: string): void {
        const key = storageKey(siteId);
        if (key === this.#key) return;
        this.#key = key;
        try {
            this.shown = sessionStorage.getItem(key) === '1';
        } catch {
            this.shown = false;
        }
    }

    toggle(): void {
        this.shown = !this.shown;
        if (!this.#key) return;
        try {
            if (this.shown) sessionStorage.setItem(this.#key, '1');
            else sessionStorage.removeItem(this.#key);
        } catch {
            // Storage blocked: the choice still holds for this tab.
        }
    }
}

export const nsfwToggle = new NsfwToggle();
