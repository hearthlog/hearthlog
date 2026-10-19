<script lang="ts">
    import { Dialog } from "bits-ui";
    import type { Snippet } from "svelte";
    import IconClose from "~icons/mdi/close";
    import { sheetStack } from "../state/sheet-stack.svelte.js";
    import IconBack from "~icons/mdi/arrow-left";
    import { primaryShortcut } from "./overlay-keys.js";

    let {
        show = false,
        title = "",
        onClose = () => {},
        children,
        footer,
    }: {
        show?: boolean;
        title?: string;
        onClose?: () => void;
        children: Snippet;
        /** Actions below the scrolling body, primary last (on the right); it answers ⌘↵. */
        footer?: Snippet;
    } = $props();

    function handleOpenChange(open: boolean) {
        if (!open && show) onClose();
    }

    // Phones: a sheet opened over another takes its place (see sheet-stack).
    let sheetId = $state<number | null>(null);
    $effect(() => {
        if (!show) return;
        const id = sheetStack.open(() => onClose());
        sheetId = id;
        return () => {
            sheetStack.remove(id);
            sheetId = null;
        };
    });
    const covered = $derived(sheetStack.covered(sheetId));
    const stacked = $derived(sheetStack.stacked(sheetId));

</script>

<Dialog.Root open={show} onOpenChange={handleOpenChange}>
    <Dialog.Portal>
        <Dialog.Overlay
            data-sheet-covered={covered ? "" : undefined}
            class="fixed inset-0 z-[var(--stor-layer-sheet)] bg-[var(--stor-overlay)]"
        />
        <Dialog.Content
            data-sheet-covered={covered ? "" : undefined}
            class="stor-sheet fixed inset-x-0 bottom-0 z-[var(--stor-layer-sheet-content)] flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col overflow-hidden rounded-t-3xl pt-[env(safe-area-inset-top)] outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[90vh] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--stor-panel-radius)] sm:pt-0"
        >
            <header class="flex shrink-0 items-center gap-3 px-4 py-3 sm:pb-2 sm:pl-6 sm:pr-5 sm:pt-5">
                {#if stacked}
                    <button
                        type="button"
                        class="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)]"
                        aria-label="Back"
                        onclick={() => onClose()}
                    ><IconBack class="h-5 w-5" /></button>
                {/if}
                <Dialog.Title level={3} class="stor-title-2 min-w-0 text-[var(--stor-ink)]">
                    {title}
                </Dialog.Title>
                <div class="ml-auto flex shrink-0 items-center gap-2">
                    <kbd class="stor-kbd max-sm:hidden" aria-hidden="true">Esc</kbd>
                    <Dialog.Close
                        class="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--stor-muted-text)] transition-colors hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] sm:h-9 sm:w-9 sm:rounded-[10px]"
                        aria-label="Close dialog"
                        aria-keyshortcuts="Escape"
                        onclick={(event) => { if (stacked) { event.preventDefault(); sheetStack.closeAll(); } }}
                    >
                        <IconClose class="h-5 w-5" />
                    </Dialog.Close>
                </div>
            </header>

            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-6 sm:pt-3">
                {@render children()}
            </div>
            {#if footer}
                <footer class="shrink-0 border-t border-[var(--stor-border)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5 sm:pl-6 sm:pr-5 sm:pt-4">
                    <div class="flex w-full flex-wrap items-center justify-end gap-2" {@attach primaryShortcut}>{@render footer()}</div>
                </footer>
            {/if}
        </Dialog.Content>
    </Dialog.Portal>
</Dialog.Root>
