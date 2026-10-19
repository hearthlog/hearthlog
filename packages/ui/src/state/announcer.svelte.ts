/**
 * The page's one polite live region: figures that change after the page has rendered announce through it, so a
 * screen reader hears "Available now: 84 312 Kč" once instead of every region speaking on its own.
 */
class Announcer {
    message = $state('');
    #timer: ReturnType<typeof setTimeout> | undefined;

    announce(message: string): void {
        // Clearing first makes an identical message speak again.
        this.message = '';
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => (this.message = message), 50);
    }
}

export const announcer = new Announcer();
