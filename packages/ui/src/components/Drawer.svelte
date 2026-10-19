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
        description = "",
        size = "md",
        onClose = () => {},
        children,
        lead,
        footer,
    }: {
        show?: boolean;
        title?: string;
        description?: string;
        size?: "md" | "lg";
        onClose?: () => void;
        children: Snippet;
        /** Stays above the scrolling body, below the title. */
        lead?: Snippet;
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

    // Phones show the drawer as a sheet sized to its content. While it is open the
    // on-screen keyboard's height lifts the sheet, so the save button stays above it.
    $effect(() => {
        if (!show || typeof window === "undefined" || !window.visualViewport) return;
        const viewport = window.visualViewport;
        const root = document.documentElement;
        const update = () => {
            const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
            root.style.setProperty("--stor-keyboard", `${Math.round(covered)}px`);
        };
        update();
        viewport.addEventListener("resize", update);
        viewport.addEventListener("scroll", update);
        return () => {
            viewport.removeEventListener("resize", update);
            viewport.removeEventListener("scroll", update);
            root.style.removeProperty("--stor-keyboard");
        };
    });

    /** On phones a sheet closes by its × or the dimmed page, so footer Cancel buttons step aside. */
    function markCancel(node: HTMLElement) {
        const mark = () => {
            for (const button of node.querySelectorAll<HTMLButtonElement>("button")) {
                if (button.textContent?.trim() === "Cancel") button.dataset.drawerCancel = "";
                else delete button.dataset.drawerCancel;
            }
        };
        mark();
        const observer = new MutationObserver(mark);
        observer.observe(node, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }
</script>

<Dialog.Root open={show} onOpenChange={handleOpenChange}>
    <Dialog.Portal>
        <Dialog.Overlay
            data-sheet-covered={covered ? "" : undefined}
            class="stor-drawer-overlay fixed inset-0 z-[var(--stor-layer-sheet)] bg-[var(--stor-overlay)]"
        />
        <Dialog.Content
            data-stor-drawer
            data-size={size}
            data-sheet-covered={covered ? "" : undefined}
            class="stor-drawer fixed right-0 top-0 z-[var(--stor-layer-sheet-content)] flex w-full flex-col pt-[env(safe-area-inset-top)] outline-none"
        >
            <span class="stor-drawer-grabber" aria-hidden="true"></span>
            <header class="stor-drawer-header flex items-start gap-3 px-4 py-4 lg:pb-2 lg:pl-6 lg:pr-5 lg:pt-5">
                {#if stacked}
                    <button
                        type="button"
                        class="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)]"
                        aria-label="Back"
                        onclick={() => onClose()}
                    ><IconBack class="h-5 w-5" /></button>
                {/if}
                <div class="min-w-0 flex-1 pt-2 sm:pt-1">
                    <Dialog.Title level={2} class="stor-title-2 text-[var(--stor-ink)]">
                        {title}
                    </Dialog.Title>
                    {#if description}
                        <Dialog.Description class="mt-0.5 text-small text-[var(--stor-muted-text)] max-md:sr-only">
                            {description}
                        </Dialog.Description>
                    {/if}
                </div>
                <div class="flex shrink-0 items-center gap-2">
                    <kbd class="stor-kbd max-lg:hidden" aria-hidden="true">Esc</kbd>
                    <Dialog.Close
                        class="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] sm:h-9 sm:w-9 sm:rounded-[10px]"
                        aria-label="Close drawer"
                        aria-keyshortcuts="Escape"
                        onclick={(event) => { if (stacked) { event.preventDefault(); sheetStack.closeAll(); } }}
                    >
                        <IconClose class="h-5 w-5" />
                    </Dialog.Close>
                </div>
            </header>
            {#if lead}
                <div class="stor-drawer-lead shrink-0 px-4 pb-3 lg:px-6">{@render lead()}</div>
            {/if}
            <div class="stor-drawer-body min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5 lg:px-6 lg:pt-3">
                {@render children()}
            </div>
            {#if footer}
                <!-- Stays below the scrolling body; the primary action sits on the right and answers ⌘↵. -->
                <footer class="stor-drawer-footer shrink-0 border-t border-[var(--stor-border)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:pb-5 lg:pl-6 lg:pr-5 lg:pt-4">
                    <div class="flex w-full flex-wrap items-center justify-end gap-2" {@attach markCancel} {@attach primaryShortcut}>{@render footer()}</div>
                </footer>
            {/if}
        </Dialog.Content>
    </Dialog.Portal>
</Dialog.Root>
