type MicrolighterModule = typeof import("microlighter");

let microlighter: Promise<MicrolighterModule> | null = null;
let highlightQueue = Promise.resolve();
let highlightScheduled = false;

export function formatJson(value: unknown): string {
    const result = JSON.stringify(value, null, 2);
    if (result === undefined) {
        throw new TypeError("The supplied value cannot be represented as JSON.");
    }
    return result;
}

/**
 * Highlight every mounted JSON viewer after Svelte has flushed its DOM.
 * Microlighter uses a document-global CSS highlight registry, so calls are
 * serialized and always scan all viewers together.
 */
export function scheduleJsonHighlight(): void {
    if (typeof window === "undefined" || typeof document === "undefined") {
        return;
    }
    if (highlightScheduled) return;

    highlightScheduled = true;
    queueMicrotask(() => {
        highlightScheduled = false;
        highlightQueue = highlightQueue
            .then(() => highlightJsonViewers())
            .catch((error: unknown) => {
                console.warn("JSON syntax highlighting is unavailable.", error);
            });
    });
}

async function highlightJsonViewers(): Promise<void> {
    const css = globalThis.CSS as typeof globalThis.CSS & {
        highlights?: unknown;
    };
    if (!css.highlights) return;

    microlighter ??= import("microlighter");
    const { highlightAll } = await microlighter;
    await highlightAll({
        root: document,
        selector: '[data-json-viewer] pre > code.language-json',
    });
}
