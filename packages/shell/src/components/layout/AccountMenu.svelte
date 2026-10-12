<script lang="ts">
    import { Popover } from 'bits-ui';
    import type { Component } from 'svelte';
    import { ACCESS_LOGOUT_ENDPOINT, LOCAL_USER_EMAIL } from '@hearthlog/runtime/access/user-session.js';
    import { beginAccessLogout } from '@hearthlog/runtime/access/session.js';
    import Tooltip from '@hearthlog/ui/components/ui/Tooltip.svelte';
    import AppearanceOptions from './AppearanceOptions.svelte';
    import IconDots from '~icons/mdi/dots-vertical';
    import IconLogout from '~icons/mdi/logout';

    interface SettingsLink {
        path: string;
        label: string;
        subtitle: string;
        icon: Component;
    }

    let {
        userEmail,
        settings,
        collapsed = false,
        isActive,
    }: {
        userEmail: string;
        settings: SettingsLink[];
        collapsed?: boolean;
        isActive: (path: string) => boolean;
    } = $props();

    let open = $state(false);
    const initial = $derived((userEmail || '?').trim().charAt(0).toUpperCase());
    const canLogOut = $derived(Boolean(userEmail) && userEmail !== LOCAL_USER_EMAIL);

    function logout(event: MouseEvent): void {
        // Full document navigation through Access so the edge clears the session.
        event.preventDefault();
        open = false;
        beginAccessLogout('/');
    }
</script>

{#snippet accountTrigger(tip: Record<string, unknown> = {})}
    <Popover.Trigger
        {...tip}
        class="group flex items-center rounded-xl text-left transition hover:bg-[color-mix(in_srgb,var(--stor-ink),transparent_95%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {collapsed ? 'mx-auto h-11 w-11 justify-center' : 'w-full gap-2.5 p-1.5'}"
        aria-label={`Account and settings, ${userEmail}`}
        data-testid={collapsed ? 'account-menu-collapsed' : 'account-menu'}
    >
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(140deg,var(--stor-accent-soft),color-mix(in_srgb,var(--stor-accent),var(--stor-surface)_72%))] text-xs font-bold text-[var(--stor-accent-strong)]" aria-hidden="true">{initial}</span>
        {#if !collapsed}
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--stor-ink)]">{userEmail}</span>
            <IconDots class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
        {/if}
    </Popover.Trigger>
{/snippet}

<Popover.Root bind:open>
    {#if collapsed}
        <!-- The rail has no label, so the avatar names itself in a tooltip. -->
        <Tooltip content={`${userEmail} · Settings and appearance`} side="right" delayDuration={150}>
            {#snippet trigger({ props })}{@render accountTrigger(props)}{/snippet}
        </Tooltip>
    {:else}
        {@render accountTrigger()}
    {/if}
    <Popover.Portal>
        <Popover.Content
            side={collapsed ? 'right' : 'top'}
            align={collapsed ? 'end' : 'start'}
            sideOffset={10}
            class="stor-menu z-[var(--stor-layer-menu)] w-72 p-2 outline-none"
        >
            <div class="flex items-center gap-2.5 px-2 pb-2 pt-1">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--stor-accent-soft)] text-sm font-bold text-[var(--stor-accent-strong)]" aria-hidden="true">{initial}</span>
                <span class="min-w-0 truncate text-sm font-semibold text-[var(--stor-ink)]" data-testid="current-user-email">{userEmail}</span>
            </div>
            <h2 class="px-2 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Appearance</h2>
            <AppearanceOptions compact />
            {#if settings.length}
                <h2 class="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Settings</h2>
                {#each settings as link}
                    {@const Icon = link.icon}
                    <a
                        href={link.path}
                        class="flex items-center gap-2.5 rounded-xl p-2 transition hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                        aria-current={isActive(link.path) ? 'page' : undefined}
                        onclick={() => (open = false)}
                    >
                        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]"><Icon class="h-4 w-4" /></span>
                        <span class="min-w-0">
                            <span class="block text-sm font-semibold text-[var(--stor-ink)]">{link.label}</span>
                            <span class="block truncate text-xs text-[var(--stor-muted-text)]">{link.subtitle}</span>
                        </span>
                    </a>
                {/each}
            {/if}
            {#if canLogOut}
                <div class="mx-1 my-2 h-px bg-[var(--stor-border)]"></div>
                <a
                    href={ACCESS_LOGOUT_ENDPOINT}
                    onclick={logout}
                    class="flex items-center gap-2.5 rounded-xl p-2 text-sm font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                    data-testid="logout-link"
                >
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]"><IconLogout class="h-4 w-4" /></span>
                    Log out
                </a>
            {/if}
        </Popover.Content>
    </Popover.Portal>
</Popover.Root>
