<script lang="ts">
    import { Dialog } from "bits-ui";
    import type { Snippet } from "svelte";
    import IconClose from "~icons/mdi/close";
    import { sheetStack } from "../state/sheet-stack.svelte.js";
    import IconBack from "~icons/mdi/arrow-left";

    let {
        show = false,
        title = "",
        onClose = () => {},
        children,
    }: {
        show?: boolean;
        title?: string;
        onClose?: () => void;
        children: Snippet;
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
            <header class="flex items-center justify-between border-b border-[var(--stor-border)] px-4 py-3 sm:px-6 sm:py-4">
                {#if stacked}
                    <button
                        type="button"
                        class="-ml-2 mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                        aria-label="Back"
                        onclick={() => onClose()}
                    ><IconBack class="h-5 w-5" /></button>
                {/if}
                <Dialog.Title level={3} class="stor-serif-title text-xl text-[var(--stor-ink)]">
                    {title}
                </Dialog.Title>
                <Dialog.Close
                    class="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--stor-muted-text)] transition-colors hover:bg-[var(--stor-surface-muted)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                    aria-label="Close dialog"
                    onclick={(event) => { if (stacked) { event.preventDefault(); sheetStack.closeAll(); } }}
                >
                    <IconClose class="h-5 w-5" />
                </Dialog.Close>
            </header>

            <div class="max-h-[calc(100dvh-4.5rem-env(safe-area-inset-top))] overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-h-[70vh] sm:px-6 sm:py-6">
                {@render children()}
            </div>
        </Dialog.Content>
    </Dialog.Portal>
</Dialog.Root>
