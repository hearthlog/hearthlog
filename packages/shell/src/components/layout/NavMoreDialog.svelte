<script lang="ts">
    import { page } from "$app/state";
    import { Dialog } from "bits-ui";
    import type { Component } from "svelte";
    import AppearanceOptions from "./AppearanceOptions.svelte";
    import LogStatusChip, { type LogStatusTone } from "./LogStatusChip.svelte";
    import IconLogout from "~icons/mdi/logout";
    import IconChevronRight from "~icons/mdi/chevron-right";
    import { ACCESS_LOGOUT_ENDPOINT, LOCAL_USER_EMAIL } from "@hearthlog/runtime/access/user-session.js";
    import { beginAccessLogout } from "@hearthlog/runtime/access/session.js";

    interface NavLink {
        path: string;
        label: string;
        subtitle?: string;
        icon: Component;
        matchPaths?: string[];
    }

    let {
        open,
        userEmail = "",
        links,
        settings = [],
        currentLogName,
        syncLabel,
        syncDescription,
        statusLine,
        statusTitle,
        tone,
        version = null,
        pulsing = false,
        dataReady = false,
        offlineAvailable = false,
        onOpenChange,
        onOpenSyncIssues,
        onOpenLogs,
    }: {
        open: boolean;
        userEmail?: string;
        links: NavLink[];
        settings?: NavLink[];
        currentLogName: string | null;
        syncLabel: string;
        syncDescription: string;
        statusLine: string;
        statusTitle: string;
        tone: LogStatusTone;
        version?: number | null;
        pulsing?: boolean;
        dataReady?: boolean;
        offlineAvailable?: boolean;
        onOpenChange: (open: boolean) => void;
        onOpenSyncIssues: () => void;
        onOpenLogs: () => void;
    } = $props();

    const initial = $derived((userEmail || "?").trim().charAt(0).toUpperCase());

    function isActive(path: string): boolean {
        if (path === "/") return page.url.pathname === "/";
        return page.url.pathname === path || page.url.pathname.startsWith(`${path}/`);
    }

    function isLinkActive(link: NavLink): boolean {
        return (link.matchPaths ?? [link.path]).some(isActive);
    }

    function close(): void {
        onOpenChange(false);
    }

    function openSyncIssues(): void {
        close();
        onOpenSyncIssues();
    }

    function logout(event: MouseEvent): void {
        event.preventDefault();
        close();
        beginAccessLogout("/");
    }
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-[51] bg-[var(--stor-overlay)] md:hidden" />
        <Dialog.Content
            class="stor-sheet fixed inset-x-3 bottom-[calc(var(--stor-mobile-bottom-inset)+var(--stor-mobile-nav-height)+10px)] z-[52] max-h-[min(42rem,calc(100dvh-6rem))] overflow-y-auto rounded-[26px] p-3 outline-none md:hidden"
            aria-label="More navigation and sync options"
        >
            <div class="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--stor-border)]" aria-hidden="true"></div>

            {#if links.length}
                <nav aria-label="More pages" class="grid gap-0.5">
                    {#each links as link}
                        {@const Icon = link.icon}
                        {@const active = isLinkActive(link)}
                        <a
                            href={link.path}
                            class="flex min-h-12 items-center gap-3 rounded-xl px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {active ? 'bg-[var(--stor-selected)]' : 'hover:bg-[var(--stor-surface-hover)]'}"
                            aria-current={active ? "page" : undefined}
                            onclick={close}
                        >
                            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] {active ? 'bg-[var(--stor-surface-raised)] text-[var(--stor-accent-strong)]' : 'bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]'}"><Icon class="h-[18px] w-[18px]" /></span>
                            <span class="min-w-0 flex-1">
                                <span class="block text-sm font-semibold text-[var(--stor-ink)]">{link.label}</span>
                                {#if link.subtitle}<span class="block truncate text-xs text-[var(--stor-muted-text)]">{link.subtitle}</span>{/if}
                            </span>
                            <IconChevronRight class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                        </a>
                    {/each}
                </nav>
                <div class="mx-1 my-2 h-px bg-[var(--stor-border)]"></div>
            {/if}

            <section aria-label="Log and sync" class="grid gap-2">
                <LogStatusChip
                    variant="row"
                    {currentLogName}
                    {statusLine}
                    {statusTitle}
                    {tone}
                    {version}
                    {pulsing}
                    disabled={!dataReady}
                    note={offlineAvailable && tone === "success" ? "Available offline" : undefined}
                    onOpen={() => (tone === "danger" ? openSyncIssues() : onOpenLogs())}
                />
                <!-- Sync details appear by exception: when sync is fine the row says everything. -->
                {#if tone !== "success"}
                    <p class="px-1 text-xs text-[var(--stor-muted-text)]">
                        <span class="font-semibold text-[var(--stor-ink)]">{syncLabel}</span> · {syncDescription}
                    </p>
                    <button type="button" class="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-[var(--stor-surface-muted)] text-xs font-semibold text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" onclick={openSyncIssues}>
                        Sync details
                    </button>
                {/if}
            </section>

            <section class="mt-3" aria-labelledby="mobile-appearance-heading">
                <h2 id="mobile-appearance-heading" class="px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Appearance</h2>
                <AppearanceOptions compact />
            </section>

            {#if settings.length}
                <section class="mt-3" aria-label="Settings">
                    <h2 class="px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Settings</h2>
                    <div class="grid grid-cols-2 gap-1.5">
                        {#each settings as link}
                            {@const Icon = link.icon}
                            <a href={link.path} onclick={close} aria-current={isLinkActive(link) ? "page" : undefined} class="flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {isLinkActive(link) ? 'bg-[var(--stor-selected)] text-[var(--stor-accent-strong)]' : 'bg-[var(--stor-surface-muted)] text-[var(--stor-ink)]'}">
                                <Icon class="h-4 w-4" /> {link.label}
                            </a>
                        {/each}
                    </div>
                </section>
            {/if}

            <section class="mt-3 flex items-center gap-2.5 rounded-xl px-1 py-1" aria-label="Account">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--stor-accent-soft)] text-sm font-bold text-[var(--stor-accent-strong)]" aria-hidden="true">{initial}</span>
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs font-semibold text-[var(--stor-ink)]" title={userEmail} data-testid="mobile-current-user-email">{userEmail || "Account"}</div>
                </div>
                {#if userEmail && userEmail !== LOCAL_USER_EMAIL}
                    <a
                        href={ACCESS_LOGOUT_ENDPOINT}
                        onclick={logout}
                        class="flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)]"
                        aria-label="Log out"
                        data-testid="mobile-logout-link"
                    >
                        <IconLogout class="h-4 w-4" /> Log out
                    </a>
                {/if}
            </section>
        </Dialog.Content>
    </Dialog.Portal>
</Dialog.Root>
