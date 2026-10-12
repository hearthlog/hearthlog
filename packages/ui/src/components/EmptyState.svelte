<script lang="ts">
    import type { Component, Snippet } from "svelte";
    import IconInbox from "~icons/mdi/inbox-outline";

    let {
        title,
        description,
        icon = IconInbox,
        children,
        surface = true,
        class: className = '',
    }: {
        title: string;
        description: string;
        icon?: Component;
        children?: Snippet;
        surface?: boolean;
        class?: string;
    } = $props();

    const Icon = $derived(icon);
</script>

<div class="{surface ? 'stor-panel' : ''} flex flex-col items-center justify-center px-4 py-8 text-center {className}">
    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--stor-accent-soft)] text-[var(--stor-accent-strong)]">
        <Icon class="h-6 w-6" />
    </div>
    <h3 class="mt-4 text-base font-semibold text-[var(--stor-ink)]">{title}</h3>
    <p class="mt-1 max-w-md text-sm leading-6 text-[var(--stor-muted-text)]">{description}</p>
    {#if children}
        <div class="mt-4">{@render children()}</div>
    {/if}
</div>
