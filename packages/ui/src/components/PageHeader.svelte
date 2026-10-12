<script lang="ts">
    import type { Snippet } from "svelte";

    let { title, showTitle = false, children, context, tabs, sidebarTabs = false, class: className = "" }: {
        title: string;
        /** The expanded desktop sidebar lists these sub-pages, so the tab row hides there. */
        sidebarTabs?: boolean;
        /** Detail pages name their subject, so the title stays visible. */
        showTitle?: boolean;
        children?: Snippet; context?: Snippet; tabs?: Snippet;
        class?: string;
    } = $props();
</script>
<header class="stor-page-header {className}" data-stor-drag>
    {#if showTitle}
        <h1 class="stor-page-title">{title}</h1>
    {:else}
        <h1 class="sr-only">{title}</h1>
        <p class="stor-page-label" aria-hidden="true">{title}</p>
    {/if}
    <div class="stor-page-header-row">
        {#if tabs}<div class="min-w-0 max-w-full {sidebarTabs ? 'stor-sidebar-owned-tabs' : ''}">{@render tabs()}</div>{/if}
        {#if children}<div class="stor-toolbar ml-auto justify-end">{@render children()}</div>{/if}
    </div>
    {#if context}<div class={tabs ? 'mt-3' : ''}>{@render context()}</div>{/if}
</header>
