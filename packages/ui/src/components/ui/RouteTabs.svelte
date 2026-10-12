<script lang="ts">
    import { tick, type Component } from 'svelte';
    import { cn } from '../../utils/cn.js';
    import DataValue from '../data/DataValue.svelte';
    import { tabIndicator } from './tab-indicator.js';

    export interface RouteTab {
        label: string;
        href: string;
        active: boolean;
        icon?: Component;
        count?: number;
    }

    let {
        label,
        tabs,
        variant = 'primary',
        class: className = '',
    }: {
        label: string;
        tabs: readonly RouteTab[];
        variant?: 'primary' | 'section';
        class?: string;
    } = $props();

    let nav = $state<HTMLElement | null>(null);

    $effect(() => {
        if (tabs.length === 0 || !nav) return;
        void tick().then(() => {
            const selected = nav?.querySelector<HTMLElement>('[aria-current="page"]');
            if (selected && nav && nav.scrollWidth > nav.clientWidth) {
                const selectedRect = selected.getBoundingClientRect();
                const navRect = nav.getBoundingClientRect();
                nav.scrollLeft += selectedRect.left - navRect.left - (nav.clientWidth - selectedRect.width) / 2;
            }
        });
    });
</script>

<nav
    bind:this={nav}
    aria-label={label}
    class={cn('stor-page-tabs mobile-scroll min-w-0 max-w-full items-center overflow-x-auto', variant === 'section' ? 'stor-section-tabs grid' : 'stor-primary-tabs flex', className)}
    {@attach tabIndicator}
>
    {#each tabs as tab (tab.href)}
        <a href={tab.href} aria-current={tab.active ? 'page' : undefined} class="stor-page-tab">
            {#if tab.icon}{@const Icon = tab.icon}<Icon class="h-5 w-5 shrink-0" />{/if}
            <span>{tab.label}</span>
            {#if tab.count !== undefined}
                <span class="stor-tab-count"><DataValue>{tab.count}</DataValue></span>
            {/if}
        </a>
    {/each}
</nav>
