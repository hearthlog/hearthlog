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

<!-- A section: a title-3 header over a hairline, then the body. Inside the page panel it is outlined, not shadowed. -->
<section class={cn('stor-panel', padding === 'all' && 'p-[var(--stor-panel-padding)]', className)} aria-label={label}>
    {#if title}
        <div class={cn('stor-panel-header', padding === 'all' ? 'stor-panel-header-flush' : 'stor-panel-header-rule')}>
            <div class="min-w-0">
                <h2 class="stor-panel-title">{title}</h2>
                {#if description}<p class="mt-0.5 text-small text-[var(--stor-muted-text)]">{description}</p>{/if}
            </div>
            {@render action?.()}
        </div>
    {/if}
    <div class={cn(padding === 'body' && 'stor-panel-body', padding === 'all' && title && 'mt-4')}>
        {@render children()}
    </div>
</section>
