/**
 * The sheets open on screen, oldest first. On phones a sheet opened from another
 * sheet takes its place: the ones below hide, the top one shows a back arrow
 * that closes it (the sheet below comes back as it was left), and its × closes
 * them all. `Drawer` and `Modal` register here while they are open.
 */
import { untrack } from 'svelte';

interface OpenSheet {
    id: number;
    close: () => void;
}

class SheetStack {
    entries = $state<OpenSheet[]>([]);
    #next = 0;

    open(close: () => void): number {
        const id = ++this.#next;
        // Called from the sheet's effect: writing must not make that effect depend on the stack.
        untrack(() => { this.entries = [...this.entries, { id, close }]; });
        return id;
    }

    remove(id: number): void {
        untrack(() => { this.entries = this.entries.filter((entry) => entry.id !== id); });
    }

    indexOf(id: number | null): number {
        return id === null ? -1 : this.entries.findIndex((entry) => entry.id === id);
    }

    /** Whether another sheet sits on top of this one. */
    covered(id: number | null): boolean {
        const index = this.indexOf(id);
        return index >= 0 && index < this.entries.length - 1;
    }

    /** Whether this sheet was opened over another one. */
    stacked(id: number | null): boolean {
        return this.indexOf(id) > 0;
    }

    closeAll(): void {
        for (const entry of [...this.entries].reverse()) entry.close();
    }
}

export const sheetStack = new SheetStack();
