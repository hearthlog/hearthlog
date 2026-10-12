<script lang="ts">
    import type { Component } from 'svelte';
    import type { HTMLAnchorAttributes } from 'svelte/elements';
    import type { AttentionTone } from '@hearthlog/runtime/store/attention.svelte.js';

    interface Props extends Omit<HTMLAnchorAttributes, 'class' | 'children'> {
        icon: Component;
        label: string;
        active: boolean;
        /** The rail: icon only, with the count as a dot. */
        collapsed: boolean;
        badge: { count: number; tone: AttentionTone; label: string } | null;
        /** The count sits on the sub-page while a section is open, so the section hides it then. */
        showCount?: boolean;
    }

    let { icon: Icon, label, active, collapsed, badge, showCount = true, ...rest }: Props = $props();
</script>

<!-- `rest` may carry tooltip props; the anchor is never a button, so its type is dropped. -->
<a
    {...rest}
    type={undefined}
    data-nav-link
    class="relative flex h-9 items-center rounded-[10px] text-[13.5px] transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--stor-focus)] {collapsed ? 'mx-auto h-10 w-11 justify-center' : 'gap-2.5 pl-3 pr-2'} {active
        ? 'stor-nav-selected font-semibold text-[var(--stor-ink)]'
        : 'font-medium text-[var(--stor-muted-text)] hover:bg-[var(--stor-nav-hover)] hover:text-[var(--stor-ink)]'}"
    aria-current={active ? 'page' : undefined}
    aria-label={badge ? `${label}, ${badge.label}` : label}
>
    <Icon class="h-[18px] w-[18px] shrink-0" />
    {#if !collapsed}<span class="min-w-0 flex-1 truncate">{label}</span>{/if}
    {#if badge && (collapsed || showCount)}
        <span class="stor-nav-badge {badge.tone === 'negative' ? 'stor-nav-badge-negative' : 'stor-nav-badge-warning'} {collapsed ? 'stor-nav-badge-dot' : ''}" aria-hidden="true">{collapsed ? '' : badge.count}</span>
    {/if}
</a>
