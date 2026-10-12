<script lang="ts">
    import type { Snippet } from 'svelte';
    import { cn } from '../../utils/cn.js';

    let {
        label,
        detail = '',
        tone = 'neutral',
        size = 'md',
        children,
        class: className = '',
    }: {
        label: string;
        detail?: string;
        tone?: 'neutral' | 'muted' | 'positive' | 'negative' | 'accent';
        size?: 'md' | 'lg';
        children: Snippet;
        class?: string;
    } = $props();

    const valueTone = {
        neutral: 'text-[var(--stor-ink)]',
        muted: 'text-[var(--stor-muted-text)] !text-base !font-medium !tracking-normal',
        positive: 'text-[var(--stor-positive)]',
        negative: 'text-[var(--stor-negative)]',
        accent: 'text-[var(--stor-accent-text)]',
    };
</script>

<div class={cn('stor-metric min-w-0', className)}>
    <p class="stor-metric-label">{label}</p>
    <p class={cn('stor-metric-value tabular-nums', size === 'md' && 'text-xl lg:text-2xl', valueTone[tone])}>{@render children()}</p>
    {#if detail}<p class="stor-metric-support">{detail}</p>{/if}
</div>
