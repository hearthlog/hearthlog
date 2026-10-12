<script lang="ts">
    import type { Snippet } from 'svelte';
    import { cn } from '../../utils/cn.js';

    let {
        title = '',
        description = '',
        action,
        children,
        padding = 'body',
        label,
        class: className = '',
    }: {
        title?: string;
        description?: string;
        action?: Snippet;
        children: Snippet;
        padding?: 'none' | 'body' | 'all';
        label?: string;
        class?: string;
    } = $props();
</script>

<section class={cn('stor-panel', padding === 'all' && 'p-[var(--stor-panel-padding)]', className)} aria-label={label}>
    {#if title}
        <div class={cn('stor-panel-header', padding === 'all' && '!p-0')}>
            <div class="min-w-0">
                <h2 class="text-base font-semibold tracking-tight text-[var(--stor-ink)]">{title}</h2>
                {#if description}<p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">{description}</p>{/if}
            </div>
            {@render action?.()}
        </div>
    {/if}
    <div class={cn(padding === 'body' && 'stor-panel-body', padding === 'all' && title && 'mt-4')}>
        {@render children()}
    </div>
</section>
