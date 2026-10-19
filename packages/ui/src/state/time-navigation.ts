/**
 * The page's time navigator, for the keyboard: ← and → step back and forward, T returns to today. A navigator
 * (MonthNavigator) registers itself while it is on screen; the shell's key handler calls whichever registered last.
 */
export interface TimeNavigation {
    previous(): void;
    next(): void;
    today(): void;
}

const registered: TimeNavigation[] = [];

export function registerTimeNavigation(navigation: TimeNavigation): () => void {
    registered.push(navigation);
    return () => {
        const index = registered.indexOf(navigation);
        if (index >= 0) registered.splice(index, 1);
    };
}

export function activeTimeNavigation(): TimeNavigation | null {
    return registered[registered.length - 1] ?? null;
}
