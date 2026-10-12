<script lang="ts">
    import type { Snippet } from 'svelte';
    import { cn } from '../../utils/cn.js';
    import Button from './Button.svelte';

    let {
        count,
        noun,
        clearVisible = false,
        onClear = () => {},
        children,
        class: className = '',
    }: {
        count: number | null;
        noun: string;
        clearVisible?: boolean;
        onClear?: () => void;
        children: Snippet;
        class?: string;
    } = $props();
</script>

<section class={cn('stor-panel p-[var(--stor-panel-padding)]', className)} aria-label={`${noun} filters`}>
    <div class="flex min-w-0 flex-wrap items-center gap-2 [&>*]:max-w-full">{@render children()}</div>
    <div class="mt-2 flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-[var(--stor-muted-text)]">
        <span role="status">{count === null ? 'Loading results…' : `Showing ${count} ${noun}${count === 1 ? '' : 's'}`}</span>
        {#if clearVisible}<Button variant="ghost" size="sm" onclick={onClear}>Clear filters</Button>{/if}
    </div>
</section>
