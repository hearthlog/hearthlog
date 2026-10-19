<script lang="ts">
    import type { Snippet } from 'svelte';
    import { cn } from '../../utils/cn.js';
    import { announcer } from '../../state/announcer.svelte.js';

    /**
     * A figure: overline label, the value (display size at `lg`), an optional unit at 0.55em, then at most one
     * support line in small type. `delta` leads that line (e.g. "▲ 40 066"); `sparkline` sits between value and line.
     */
    let {
        label,
        detail = '',
        tone = 'neutral',
        size = 'md',
        unit = '',
        delta,
        sparkline,
        children,
        class: className = '',
    }: {
        label: string;
        detail?: string;
        tone?: 'neutral' | 'muted' | 'positive' | 'negative' | 'accent';
        size?: 'md' | 'lg';
        unit?: string;
        delta?: Snippet;
        sparkline?: Snippet;
        children: Snippet;
        class?: string;
    } = $props();

    // A figure that changes after it first showed announces its new value (not on first render or sync of the same text).
    let valueElement = $state<HTMLElement>();
    let previous: string | null = null;
    $effect(() => {
        const element = valueElement;
        if (!element) return;
        const read = () => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        previous = read();
        const observer = new MutationObserver(() => {
            const next = read();
            if (next && next !== previous) {
                if (previous) announcer.announce(`${label}: ${next}`);
                previous = next;
            }
        });
        observer.observe(element, { childList: true, characterData: true, subtree: true });
        return () => observer.disconnect();
    });

    const valueTone = {
        neutral: 'text-[var(--stor-ink)]',
        muted: 'text-[var(--stor-muted-text)] !text-base !font-medium !tracking-normal',
        positive: 'text-[var(--stor-positive)]',
        negative: 'text-[var(--stor-negative)]',
        accent: 'text-[var(--stor-accent-text)]',
    };
</script>

<div class={cn('stor-metric min-w-0', className)} data-size={size}>
    <p class="stor-metric-label">{label}</p>
    <p bind:this={valueElement} class={cn('stor-metric-value tabular-nums', valueTone[tone])}>{@render children()}{#if unit}<span class="stor-unit ml-[0.18em]">{unit}</span>{/if}</p>
    {#if sparkline}<div class="stor-metric-spark">{@render sparkline()}</div>{/if}
    {#if delta || detail}<p class="stor-metric-support">{#if delta}<span class="stor-metric-delta">{@render delta()}</span>{/if}{#if detail}<span>{detail}</span>{/if}</p>{/if}
</div>
