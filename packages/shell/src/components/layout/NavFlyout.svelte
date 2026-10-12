<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { NavChild } from '@hearthlog/contracts/features/navigation';
    import type { AttentionTone } from '@hearthlog/runtime/store/attention.svelte.js';

    type Badge = { count: number; tone: AttentionTone; label: string };
    interface Item {
        child: NavChild;
        href: string;
        active: boolean;
        badge: Badge | null;
    }

    let {
        label,
        badge,
        items,
        trigger,
    }: {
        label: string;
        /** The section's own badge, named in the flyout header. */
        badge: Badge | null;
        items: Item[];
        /** The section link. It stays the real navigation target; the flyout only adds shortcuts. */
        trigger: Snippet;
    } = $props();

    let root = $state<HTMLElement>();
    let panel = $state<HTMLElement>();
    let open = $state(false);
    let top = $state(0);
    let left = $state(0);
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set while Escape hands focus back to the section link, which must not reopen the flyout. */
    let returningFocus = false;

    /** Sits 12px right of the rail, level with the section link, and stays inside the viewport. */
    function place(): void {
        const link = root?.querySelector<HTMLElement>('[data-nav-link]');
        const rail = root?.closest('aside');
        if (!link || !rail || !panel) return;
        left = rail.getBoundingClientRect().right + 12;
        top = Math.max(12, Math.min(link.getBoundingClientRect().top - 6, window.innerHeight - panel.offsetHeight - 12));
    }

    function show(): void {
        clearTimeout(closeTimer);
        place();
        open = true;
    }

    function hide(): void {
        clearTimeout(openTimer);
        open = false;
    }

    // Hover opens after a short intent delay and only for a real mouse: a tap must navigate, not open.
    function onPointerEnter(event: PointerEvent): void {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(closeTimer);
        openTimer = setTimeout(show, 90);
    }

    function onPointerLeave(event: PointerEvent): void {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(openTimer);
        closeTimer = setTimeout(hide, 120);
    }

    // Keyboard focus opens it so the pages are reachable without a mouse; a click or tap focus does not.
    function onFocusIn(event: FocusEvent): void {
        if (!returningFocus && (event.target as HTMLElement).matches(':focus-visible')) show();
    }

    function onFocusOut(event: FocusEvent): void {
        if (!root?.contains(event.relatedTarget as Node | null)) hide();
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        hide();
        returningFocus = true;
        root?.querySelector<HTMLElement>('[data-nav-link]')?.focus();
        returningFocus = false;
    }
</script>

<div
    bind:this={root}
    role="presentation"
    onpointerenter={onPointerEnter}
    onpointerleave={onPointerLeave}
    onfocusin={onFocusIn}
    onfocusout={onFocusOut}
    onkeydown={onKeydown}
    onclick={hide}
>
    {@render trigger()}
    <div
        bind:this={panel}
        class="stor-nav-fly"
        data-open={open ? '' : undefined}
        style:top="{top}px"
        style:left="{left}px"
        role="group"
        aria-label={`${label} pages`}
    >
        <div class="stor-nav-fly-head">
            <span class="min-w-0 truncate">{label}</span>
            {#if badge}
                <span class="stor-nav-badge {badge.tone === 'negative' ? 'stor-nav-badge-negative' : 'stor-nav-badge-warning'} shrink-0">{badge.count} overdue</span>
            {/if}
        </div>
        <ul>
            {#each items as item (item.child.id)}
                <li><a
                    href={item.href}
                    class="stor-nav-child {item.active ? 'stor-nav-child-active' : ''}"
                    aria-current={item.active ? 'page' : undefined}
                    aria-label={item.badge ? `${item.child.label}, ${item.badge.label}` : undefined}
                >
                    <span class="min-w-0 flex-1 truncate">{item.child.label}</span>
                    {#if item.badge}
                        <span class="stor-nav-badge {item.badge.tone === 'negative' ? 'stor-nav-badge-negative' : 'stor-nav-badge-warning'}" aria-hidden="true">{item.badge.count}</span>
                    {/if}
                </a></li>
            {/each}
        </ul>
    </div>
</div>
