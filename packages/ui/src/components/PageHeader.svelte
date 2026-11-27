<script lang="ts">
    import type { Snippet } from "svelte";
    import { scrollEdge } from "../utils/scroll-edge.js";

    let { title, showTitle = false, children, context, tabs, condensed, sticky = false, sidebarTabs = false, class: className = "" }: {
        title: string;
        /** The expanded desktop sidebar lists these sub-pages, so the tab row hides there. */
        sidebarTabs?: boolean;
        /** Detail pages name their subject, so the title stays visible. */
        showTitle?: boolean;
        /**
         * Keeps the header row in view while the page scrolls (from 768px): once it reaches the top of the page panel
         * it turns into a glass capsule that names the page, and the title and context step aside without moving
         * anything below. For pages that scroll the page itself; a list that scrolls on its own keeps its header above it.
         */
        sticky?: boolean;
        /** Shown in the capsule after the page's name while a sticky header is stuck: one short figure. */
        condensed?: Snippet;
        children?: Snippet; context?: Snippet; tabs?: Snippet;
        class?: string;
    } = $props();

    let stuck = $state(false);

    /** How far the row sits below the header's top, so the row (not the title above it) sticks 10px from the edge. */
    function measureLead(header: HTMLElement): () => void {
        const row = header.querySelector<HTMLElement>(":scope > .stor-page-header-row");
        if (!row) return () => {};
        const observer = new ResizeObserver(() => header.style.setProperty("--stor-header-lead", `${row.offsetTop}px`));
        observer.observe(header);
        return () => observer.disconnect();
    }
</script>
<header
    class="stor-page-header {className}"
    data-stor-drag
    data-sticky={sticky ? "" : undefined}
    {@attach sticky && measureLead}
    {@attach sticky && scrollEdge({ edge: "stuck", onChange: (value) => (stuck = value) })}
>
    {#if showTitle}
        <h1 class="stor-page-title">{title}</h1>
    {:else}
        <h1 class="sr-only">{title}</h1>
        <p class="stor-page-label" aria-hidden="true">{title}</p>
    {/if}
    <div class={["stor-page-header-row", stuck && "stor-glass-strong"]}>
        {#if sticky}
            <span class="stor-page-header-condensed">
                <span class="stor-serif-title" aria-hidden="true">{title}</span>
                {@render condensed?.()}
            </span>
        {/if}
        {#if tabs}<div class="min-w-0 max-w-full {sidebarTabs ? 'stor-sidebar-owned-tabs' : ''}">{@render tabs()}</div>{/if}
        {#if children}<div class="stor-toolbar ml-auto justify-end">{@render children()}</div>{/if}
    </div>
    {#if context}<div class={tabs ? 'mt-3' : ''}>{@render context()}</div>{/if}
</header>
