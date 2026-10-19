<script lang="ts">
    import type { Component, Snippet } from "svelte";
    import IconInbox from "~icons/mdi/inbox-outline";

    /**
     * An empty place: a domain line illustration (or a quiet icon tile), a serif title, one sentence, and the
     * actions that fill it (primary first, an optional secondary after it) as children.
     */
    let {
        title,
        description,
        icon = IconInbox,
        illustration,
        children,
        surface = true,
        class: className = '',
    }: {
        title: string;
        description: string;
        icon?: Component;
        /** Drawn in place of the icon tile, about 120×84, in token colours. */
        illustration?: Snippet;
        children?: Snippet;
        surface?: boolean;
        class?: string;
    } = $props();

    const Icon = $derived(icon);
</script>

<div class="{surface ? 'stor-panel' : ''} flex flex-col items-center justify-center gap-3.5 px-6 py-8 text-center {className}">
    {#if illustration}
        <div class="flex justify-center text-[var(--stor-muted-text)]" aria-hidden="true">{@render illustration()}</div>
    {:else}
        <div class="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)] shadow-[inset_0_0_0_1px_var(--stor-border)]" aria-hidden="true">
            <Icon class="h-6 w-6" />
        </div>
    {/if}
    <h3 class="stor-title-2 text-[var(--stor-ink)]">{title}</h3>
    <p class="-mt-1.5 max-w-xs text-small text-[var(--stor-muted-text)]">{description}</p>
    {#if children}
        <div class="flex flex-wrap items-center justify-center gap-2 pt-0.5">{@render children()}</div>
    {/if}
</div>
