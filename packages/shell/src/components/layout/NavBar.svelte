<script lang="ts">
    import { page } from "$app/state";
    import { historyRouteUrl, navigateHistory } from '@hearthlog/runtime/history/navigation.js';
    import { HISTORY_PARAMS } from '@hearthlog/runtime/history/url.js';
    import BrandWordmark from "./BrandWordmark.svelte";
    import type { Component } from "svelte";
    import type { LogLineageIndex, LogSummary } from "@hearthlog/runtime/ledger/index.js";
    import type { LocalStorePhase } from "@hearthlog/runtime/store/local-store.svelte.js";
    import {
        describeAppDataState,
        type SyncPhase,
    } from "@hearthlog/runtime/store/sync-state.js";
    import { navIndicator } from "./nav-indicator.js";
    import { placeHref, placeTitle, recentPlaces } from "./recent-places.svelte.js";
    import SidebarResizer from "./SidebarResizer.svelte";
    import NavItem from "./NavItem.svelte";
    import NavFlyout from "./NavFlyout.svelte";
    import Tooltip from "@hearthlog/ui/components/ui/Tooltip.svelte";
    import LogStatusChip from "./LogStatusChip.svelte";
    import { logVersion, refreshLogVersion } from "@hearthlog/runtime/store/log-version.svelte.js";
    import Drawer from '@hearthlog/ui/components/Drawer.svelte';
    import Button from '@hearthlog/ui/components/ui/Button.svelte';
    import DataPlaceholder from '@hearthlog/ui/components/data/DataPlaceholder.svelte';
    import AccountMenu from "./AccountMenu.svelte";
    import { buildNavigation, type NavChild } from "@hearthlog/contracts/features/navigation";
    import { attention } from "@hearthlog/runtime/store/attention.svelte.js";
    import { events } from "@hearthlog/runtime/store/events.svelte.js";
    import { tenant } from "@hearthlog/contracts/tenant/config";
    import { DEVELOPER_ICON, ENTITIES_ICON, FEATURE_ICONS } from "./feature-icons.js";
    import { MODULE_SECTION_ICONS } from "#generated/module-icons";
    import IconDots from "~icons/mdi/dots-horizontal";
    import IconChevronDown from "~icons/mdi/chevron-down";
    import IconCheck from "~icons/mdi/check";
    import { DropdownMenu } from "bits-ui";
    import { goto } from "$app/navigation";
    import { phoneHeader } from "@hearthlog/runtime/runtime/phone-header.svelte.js";
    import IconDockLeft from "~icons/mdi/dock-left";
    import IconDockRight from "~icons/mdi/dock-right";

    type LogPanelComponent = typeof import('./LogPanel.svelte').default;

    type NavMoreDialogComponent =
        typeof import("./NavMoreDialog.svelte").default;

    interface NavLink {
        id: string;
        path: string;
        label: string;
        icon: Component;
        matchPaths?: string[];
        mobilePrimary?: boolean;
        mobileOrder?: number;
        children?: NavChild[];
    }

    interface NavGroup {
        label: string;
        links: NavLink[];
    }

    const navigation = buildNavigation(tenant);
    const navGroups: NavGroup[] = navigation.groups.map((group) => ({
        ...group,
        links: group.links.map((link) => ({ ...link, icon: link.section ? MODULE_SECTION_ICONS[link.section] : FEATURE_ICONS[link.id as keyof typeof FEATURE_ICONS] })),
    }));
    const settingsLinks = navigation.settings.map((link) => ({
        ...link,
        icon: link.id === "entities" ? ENTITIES_ICON : DEVELOPER_ICON,
    }));
    const navLinks = navGroups.flatMap((group) => group.links);
    const mobilePrimaryLinks = navLinks
        .filter((link) => link.mobilePrimary)
        .sort((left, right) => (left.mobileOrder ?? 99) - (right.mobileOrder ?? 99));
    const moreNavLinks = navLinks.filter((link) => !link.mobilePrimary);

    let {
        userEmail,
        logs,
        lineage,
        currentLogId,
        currentLogName,
        localStorePhase,
        localStoreErrorMessage,
        syncPhase,
        syncErrorMessage,
        pendingUploads,
        needsAttention,
        offlineAvailable = false,
        lastSyncedAt,
        collapsed,
        dataReady = false,
        onToggleCollapsed,
        sidebarWidth,
        onResizeSidebar,
        onOpenSyncIssues,
        onSwitchLog,
        onCreateLog,
    }: {
        userEmail: string;
        logs: LogSummary[];
        lineage: LogLineageIndex | null;
        currentLogId: string | null;
        currentLogName: string | null;
        localStorePhase: LocalStorePhase;
        localStoreErrorMessage: string | null;
        syncPhase: SyncPhase;
        syncErrorMessage: string | null;
        pendingUploads: number;
        needsAttention: number;
        offlineAvailable?: boolean;
        lastSyncedAt: Date | null;
        collapsed: boolean;
        dataReady?: boolean;
        onToggleCollapsed: () => void;
        sidebarWidth: number;
        onResizeSidebar: (width: number, folded: boolean, final: boolean) => void;
        onOpenSyncIssues: () => void;
        onSwitchLog: (logId: string) => Promise<void>;
        onCreateLog: () => void;
    } = $props();

    let isMoreOpen = $state(false);
    const logTreeOpen = $derived(historyRouteUrl().searchParams.has('logPanel'));
    let NavMoreDialog = $state<NavMoreDialogComponent | null>(null);
    let navMoreDialogLoadPromise: Promise<void> | null = null;
    let LogPanel = $state<LogPanelComponent | null>(null);
    let logPanelLoadFailed = $state(false);
    let logPanelLoadPromise: Promise<void> | null = null;

    $effect(() => {
        if (!logTreeOpen || LogPanel) return;
        logPanelLoadPromise ??= import('./LogPanel.svelte')
            .then((module) => { LogPanel = module.default; })
            .catch(() => { logPanelLoadFailed = true; });
    });

    const activeMoreLink = $derived.by(() =>
        moreNavLinks.find(isLinkActive) ??
        null,
    );

    const isMoreActive = $derived(isMoreOpen || activeMoreLink !== null);
    // Spatial spec: More keeps the visible label "More" even when the
    // current secondary page lives inside it (e.g. Calculator).
    const moreButtonLabel = "More";

    $effect(() => {
        if (!dataReady) return;
        const currentUrl = historyRouteUrl();
        const params = new URLSearchParams(currentUrl.hash.slice(1));
        const requestedPoint = params.get('open-history');
        if (requestedPoint === null) return;
        const version = Number(requestedPoint);
        const cleanUrl = new URL(currentUrl);
        cleanUrl.hash = '';
        cleanUrl.searchParams.set('logPanel', 'activity');
        if (Number.isSafeInteger(version) && version > 0) cleanUrl.searchParams.set('historyVersion', String(version));
        navigateHistory(cleanUrl, true);
    });

    const moreButtonAriaLabel = $derived(
        isMoreOpen
            ? "Close menu"
            : activeMoreLink
              ? `Open menu. Current page: ${activeMoreLink.label}`
              : "Open menu",
    );

    const syncPresentation = $derived.by(() => {
        // Truthful sync state: a local save is not proof of remote sync.
        // Never report "Synced" before local data is ready.
        if (!dataReady && localStorePhase !== "failed") {
            return { label: "Loading…", description: "Opening local data", tone: "neutral" as const };
        }
        return describeAppDataState({
            localStorePhase,
            localStoreErrorMessage,
            syncPhase,
            syncErrorMessage,
            pendingUploads,
            needsAttention,
            lastSyncedAt,
        });
    });
    const syncLabel = $derived(syncPresentation.label);
    const syncDescription = $derived(syncPresentation.description);
    const syncTitle = $derived(
        `${syncLabel}. ${syncDescription}${offlineAvailable ? ". Available offline." : ""}`,
    );
    const createLogDisabledReason = $derived.by(() => {
        if (!dataReady) return "Wait for local data to open";
        if (syncPhase === "offline") return "Connect to the internet to create a log";
        return undefined;
    });
    const syncTone = $derived(syncPresentation.tone);
    /** Short state under the log name: "Synced · 12:09", "3 pending", "Offline". */
    const syncLine = $derived(
        syncPhase === "synced" && lastSyncedAt && dataReady
            ? `Synced · ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : syncLabel,
    );
    const syncShort = $derived(syncTone === "danger" ? "Review" : syncLabel);

    // Badges re-count after every event change, log switch, and once data opens.
    $effect(() => {
        void events.updatedAt;
        void currentLogId;
        if (!dataReady) return;
        void attention.refresh();
    });

    // The log's version moves with every accepted event and every local save.
    $effect(() => {
        void events.updatedAt;
        void currentLogId;
        if (!dataReady) return;
        void refreshLogVersion(currentLogId);
    });

    const version = $derived(logVersion.value);

    const showSyncDot = $derived(
        syncPresentation.tone === "warning" ||
        syncPresentation.tone === "danger" ||
        syncPhase === "syncing",
    );

    function pathMatches(pathname: string, path: string): boolean {
        if (path === "/") return pathname === "/";
        return pathname === path || pathname.startsWith(`${path}/`);
    }

    function isActive(path: string): boolean {
        return pathMatches(page.url.pathname, path);
    }

    // ---------------------------------------------------------------- recently
    /** The place in view, once its title settles: pages name it in `<title>` after their data loads. */
    function rememberPlace(): void {
        // An error page is no place to return to.
        if (page.error) return;
        const url = new URL(window.location.href);
        const link = navLinks.find((candidate) => (candidate.matchPaths ?? [candidate.path]).some((path) => pathMatches(url.pathname, path)));
        if (!link) return;
        const title = placeTitle(document.title, link.label, tenant.title);
        if (title) recentPlaces.record({ href: placeHref(url), title, section: link.id });
    }

    let rememberTimer: ReturnType<typeof setTimeout> | undefined;
    function settlePlace(): void {
        clearTimeout(rememberTimer);
        rememberTimer = setTimeout(rememberPlace, 700);
    }

    // The log's list opens with its data; a title change or a move to another address records the place.
    $effect(() => {
        if (!dataReady || !currentLogId) return;
        recentPlaces.open(tenant.id, currentLogId);
        const titles = new MutationObserver(settlePlace);
        titles.observe(document.head, { subtree: true, childList: true, characterData: true });
        settlePlace();
        return () => {
            clearTimeout(rememberTimer);
            titles.disconnect();
        };
    });

    $effect(() => {
        void page.url.href;
        if (dataReady && currentLogId) settlePlace();
    });

    /** Up to four places outside the section in view, each with its section's icon. */
    const recentShown = $derived.by(() => {
        const here = navLinks.find(isLinkActive)?.id ?? null;
        return recentPlaces.places
            .filter((place) => place.section !== here)
            .flatMap((place) => {
                const link = navLinks.find((candidate) => candidate.id === place.section);
                return link ? [{ ...place, icon: link.icon, sectionLabel: link.label }] : [];
            })
            .slice(0, 4);
    });

    function isLinkActive(link: NavLink): boolean {
        return (link.matchPaths ?? [link.path]).some(isActive);
    }

    function linkHref(path: string): string { return path; }

    /** A query-only child keeps the section's current path, e.g. the viewed Finance month. */
    function childHref(link: NavLink, child: NavChild): string {
        if (child.tab === undefined) return child.href;
        const base = isLinkActive(link) ? page.url.pathname : link.path;
        return child.tab ? `${base}?tab=${child.tab}` : base;
    }

    /**
     * The selected sub-page. Invoices switches tabs with shallow routing, so its
     * page state is newer than the address the router last loaded.
     */
    function currentTab(): string | null {
        const shallow = (page.state as { invoiceRoute?: { tab?: string } }).invoiceRoute;
        return shallow?.tab ?? page.url.searchParams.get("tab");
    }

    function isChildActive(link: NavLink, child: NavChild): boolean {
        if (child.tab !== undefined) {
            const tab = currentTab();
            const known = link.children?.some((option) => option.tab && option.tab === tab);
            return child.tab ? tab === child.tab : !known;
        }
        // Path children: the longest matching route wins (/calories/foods over /calories).
        const matches = (link.children ?? []).filter((option) => isActive(option.href));
        const best = matches.sort((left, right) => right.href.length - left.href.length)[0];
        return best?.id === child.id;
    }

    // ---------------------------------------------------------------- phone top bar
    /** The section in view names the bar; its sub-pages open from the title. */
    const phoneSection = $derived(
        navLinks.find(isLinkActive) ?? settingsLinks.find((link) => isActive(link.path)) ?? null,
    );
    const phoneChildren = $derived(
        phoneSection && "children" in phoneSection && phoneSection.children && phoneSection.children.length > 1
            ? phoneSection.children
            : [],
    );
    const phoneChild = $derived(phoneChildren.find((child) => isChildActive(phoneSection as NavLink, child)) ?? null);
    const phoneTitle = $derived(phoneChild?.label ?? phoneSection?.label ?? "");
    const phoneSmall = $derived(
        [phoneChildren.length > 0 ? phoneSection?.label : null, phoneHeader.context].filter(Boolean).join(" · "),
    );
    /** A copied log keeps its name in sight; the first log needs only the status. */
    const inCopiedLog = $derived(!!lineage && !!currentLogId && !lineage.rootIds.includes(currentLogId));

    function openLogChip(): void {
        openLogTree();
    }

    function loadNavMoreDialog(): Promise<void> {
        navMoreDialogLoadPromise ??= import("./NavMoreDialog.svelte").then(
            (module) => {
                NavMoreDialog = module.default;
            },
        );
        return navMoreDialogLoadPromise;
    }

    function setMoreOpen(open: boolean): void {
        isMoreOpen = open;
        if (open) void loadNavMoreDialog();
    }

    function openLogTree(): void {
        const url = new URL(window.location.href);
        url.searchParams.set('logPanel', 'activity');
        navigateHistory(url);
    }

    function closeLogTree(): void {
        const url = new URL(window.location.href);
        for (const key of HISTORY_PARAMS) url.searchParams.delete(key);
        navigateHistory(url, true);
    }

    function toggleMore(): void {
        setMoreOpen(!isMoreOpen);
    }


</script>

<aside
    class="fixed left-0 top-0 bottom-0 z-50 hidden flex-col bg-[var(--stor-sidebar)] transition-[width] duration-150 ease-out motion-reduce:transition-none md:flex {collapsed
        ? 'w-20'
        : 'w-[var(--stor-sidebar-width)]'}"
    data-testid="desktop-sidebar"
>
    <div class="flex shrink-0 {collapsed ? 'flex-col items-center gap-2 px-2 pt-4' : 'h-[4.5rem] items-center gap-2 pl-3.5 pr-2.5'}" data-stor-drag>
        <!-- Reserved for the native window controls; empty and hidden outside the Mac app. -->
        <span class="stor-lights" data-stor-lights aria-hidden="true"></span>
        <!-- The Mac app names itself in the menu bar, so its sidebar drops the brand (app.css). -->
        <a href={linkHref("/")} data-stor-brand class="flex min-w-0 items-center gap-3 rounded-xl font-semibold text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" title={tenant.title}>
            {#if collapsed}
                <span class="stor-brand-logo"><span class="stor-mark"></span></span>
            {:else}
                <span class="stor-brand-title truncate"><BrandWordmark title={tenant.title} /></span>
            {/if}
        </a>
        <button
            type="button"
            class="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-hover)] lg:flex hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] {collapsed ? '' : 'ml-auto'}"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onclick={onToggleCollapsed}
        >
            {#if collapsed}<IconDockRight class="h-4.5 w-4.5" />{:else}<IconDockLeft class="h-4.5 w-4.5" />{/if}
        </button>
    </div>

    <nav class="relative min-h-0 flex-1 overflow-y-auto pb-3 pt-2 {collapsed ? 'px-2' : 'px-3'}" aria-label="Main navigation" {@attach navIndicator}>
        {#each navGroups as group, groupIndex}
            <section class={groupIndex > 0 ? (collapsed ? "mt-2 border-t border-[var(--stor-border)] pt-2" : "mt-3") : ""} aria-label={group.label || "Pages"}>
                {#if group.label && !collapsed}<p class="px-3 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">{group.label}</p>{/if}
                <div class="space-y-0.5">
                    {#each group.links as link}
                        {@const active = isLinkActive(link)}
                        {@const badge = attention.badge(link.id)}
                        {@const figure = attention.figure(link.id)}
                        {#if !collapsed}
                            <!-- The current section is one raised card: its row and its open sub-pages. -->
                            <div data-nav-section data-active={active ? '' : undefined}>
                                <!-- The count sits on the sub-page that holds the work while the section is open. -->
                                <NavItem
                                    href={linkHref(link.path)}
                                    icon={link.icon}
                                    label={link.label}
                                    {active}
                                    {collapsed}
                                    {badge}
                                    {figure}
                                    showCount={!(active && link.children)}
                                />
                                {#if link.children}
                                    <!-- Sub-pages stay in the DOM and open in place; closed lists are invisible to focus. -->
                                    <div class="stor-nav-sub" data-open={active ? '' : undefined}>
                                        <div class="stor-nav-sub-in">
                                            <ul class="stor-nav-children" aria-label={`${link.label} pages`}>
                                                {#each link.children as child}
                                                    {@const childActive = active && isChildActive(link, child)}
                                                    {@const childBadge = child.badgeId ? attention.badge(child.badgeId) : null}
                                                    {@const childFigure = childBadge ? null : attention.figure(child.id)}
                                                    <li><a
                                                        href={childHref(link, child)}
                                                        class="stor-nav-child {childActive ? 'stor-nav-child-active' : ''}"
                                                        aria-current={childActive ? "page" : undefined}
                                                        aria-label={childBadge || childFigure ? [child.label, childBadge?.label ?? childFigure?.label].join(', ') : undefined}
                                                    >
                                                        <span class="min-w-0 truncate {childFigure ? 'flex-none' : 'flex-1'}">{child.label}</span>
                                                        {#if childBadge}
                                                            <span class="stor-nav-badge {childBadge.tone === 'negative' ? 'stor-nav-badge-negative' : 'stor-nav-badge-warning'}" aria-hidden="true">{childBadge.count}</span>
                                                        {:else if childFigure}
                                                            <span class="stor-nav-figure" aria-hidden="true">{childFigure.text}</span>
                                                        {/if}
                                                    </a></li>
                                                {/each}
                                            </ul>
                                        </div>
                                    </div>
                                {/if}
                            </div>
                        {:else if link.children}
                            <!-- Rail: a section with pages opens a flyout beside the rail. -->
                            <NavFlyout
                                label={link.label}
                                {badge}
                                {figure}
                                items={link.children.map((child) => ({
                                    child,
                                    href: childHref(link, child),
                                    active: active && isChildActive(link, child),
                                    badge: child.badgeId ? attention.badge(child.badgeId) : null,
                                    figure: attention.figure(child.id),
                                }))}
                            >
                                {#snippet trigger()}
                                    <NavItem href={linkHref(link.path)} icon={link.icon} label={link.label} {active} {collapsed} {badge} {figure} />
                                {/snippet}
                            </NavFlyout>
                        {:else}
                            <!-- Rail: a section without pages names itself in a tooltip. -->
                            <Tooltip content={[link.label, badge?.label, figure?.label].filter(Boolean).join(' · ')} side="right" delayDuration={150}>
                                {#snippet trigger({ props })}
                                    <NavItem {...props} href={linkHref(link.path)} icon={link.icon} label={link.label} {active} {collapsed} {badge} {figure} />
                                {/snippet}
                            </Tooltip>
                        {/if}
                    {/each}
                </div>
            </section>
        {/each}
    </nav>

    {#if !collapsed && recentShown.length > 0}
        <!-- Where this device was lately in this log, outside the section in view. -->
        <section class="shrink-0 px-3 pb-2" aria-label="Recently">
            <p class="px-3 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--stor-muted-text)]">Recently</p>
            <ul class="flex flex-col gap-px">
                {#each recentShown as place (place.href)}
                    {@const Icon = place.icon}
                    <li><a href={place.href} class="stor-recent-place" aria-label={`${place.title}, ${place.sectionLabel}`}>
                        <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                        <span class="flex min-w-0 flex-col leading-tight" aria-hidden="true">
                            <span class="truncate text-[13px] font-medium text-[var(--stor-ink)]">{place.title}</span>
                            <span class="truncate text-[11.5px] text-[var(--stor-muted-text)]">{place.sectionLabel}</span>
                        </span>
                    </a></li>
                {/each}
            </ul>
        </section>
    {/if}

    <!-- Places sit above the line; the log, its sync state and the account sit below it. -->
    <div class="shrink-0 border-t border-[var(--stor-border)] {collapsed ? 'flex flex-col items-center gap-0.5 px-2 py-2.5' : 'space-y-0.5 px-2.5 py-2'}">
        <LogStatusChip
            variant={collapsed ? "tile" : "foot"}
            {currentLogName}
            statusLine={syncLine}
            statusTitle={syncTitle}
            tone={syncTone}
            {version}
            pulsing={syncPhase === "syncing"}
            disabled={!dataReady}
            expanded={logTreeOpen}
            onOpen={openLogChip}
        />
        <AccountMenu {userEmail} settings={settingsLinks} {collapsed} {isActive} />
    </div>
    <div class="hidden lg:block"><SidebarResizer width={sidebarWidth} folded={collapsed} onChange={onResizeSidebar} /></div>
</aside>

{#if logTreeOpen}
    {#if LogPanel}
        <LogPanel
            show={logTreeOpen}
            {logs}
            {lineage}
            {currentLogId}
            {currentLogName}
            onClose={closeLogTree}
            onSwitch={onSwitchLog}
            onCreate={onCreateLog}
            onOpenSyncIssues={onOpenSyncIssues}
            createDisabled={createLogDisabledReason !== undefined}
            createDisabledReason={createLogDisabledReason}
        />
    {:else}
        <Drawer show={logTreeOpen} title={currentLogName ?? 'Your log'} onClose={closeLogTree}>
            {#if logPanelLoadFailed}
                <p role="alert" class="text-sm text-[var(--stor-muted-text)]">Could not load log history.</p>
                <Button variant="secondary" class="mt-3" onclick={() => window.location.reload()}>Reload</Button>
            {:else}
                <DataPlaceholder rows={6} label="Loading log history" />
            {/if}
        </Drawer>
    {/if}
{/if}

{#snippet phoneTitleBlock(menu: boolean)}
    <span class="flex min-w-0 flex-col items-start leading-tight">
        {#if phoneSmall}<span class="max-w-full truncate text-[11.5px] font-medium text-[var(--stor-muted-text)]">{phoneSmall}</span>{/if}
        <span class="stor-serif-title flex min-w-0 max-w-full items-center gap-0.5 text-[21px] leading-[1.15] text-[var(--stor-ink)]">
            <span class="truncate">{phoneTitle}</span>
            {#if menu}<IconChevronDown class="h-[18px] w-[18px] shrink-0 text-[var(--stor-muted-text)]" />{/if}
        </span>
    </span>
{/snippet}

<!-- The phone top bar: the section and sub-page on the left, the page's one figure and the log on the right. -->
<header class="stor-mobile-header fixed inset-x-0 top-0 z-50 flex h-[var(--stor-mobile-header-height)] items-center gap-2 pl-4 pr-2.5 pt-[env(safe-area-inset-top)] md:hidden" data-testid="phone-top-bar">
    {#if phoneHeader.selection}
        {@const selecting = phoneHeader.selection}
        <p class="stor-serif-title mr-auto truncate text-[21px] text-[var(--stor-ink)]" role="status">{selecting.label}</p>
        {#if selecting.onSelectAll}<button type="button" class="min-h-11 px-2 text-[15px] font-semibold text-[var(--stor-accent-text)]" onclick={selecting.onSelectAll}>Select all</button>{/if}
        <button type="button" class="min-h-11 px-2 text-[15px] font-semibold text-[var(--stor-accent-text)]" onclick={selecting.onCancel}>Cancel</button>
    {:else if !phoneSection}
        <a href={linkHref("/")} class="flex min-w-0 shrink-0 items-center gap-2" title={tenant.title} aria-label={`Open ${tenant.title} start section`}>
            <span class="min-[360px]:hidden"><span class="stor-brand-logo"><span class="stor-mark"></span></span></span>
            <span class="stor-brand-title hidden min-w-0 truncate text-[var(--stor-ink)] min-[360px]:block"><BrandWordmark title={tenant.title} /></span>
        </a>
    {:else if phoneChildren.length > 0}
        <DropdownMenu.Root>
            <DropdownMenu.Trigger
                class="-ml-1 flex min-w-0 shrink items-center rounded-xl px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]"
                aria-label={`${phoneSection.label}: ${phoneTitle}. Switch page`}
                data-testid="phone-section-menu"
            >
                {@render phoneTitleBlock(true)}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content side="bottom" align="start" sideOffset={6} loop class="stor-menu z-[var(--stor-layer-menu)] w-60 overflow-hidden p-1.5">
                    {#each phoneChildren as child (child.id)}
                        {@const childActive = phoneChild?.id === child.id}
                        {@const childBadge = child.badgeId ? attention.badge(child.badgeId) : null}
                        <DropdownMenu.Item
                            class="flex min-h-12 cursor-default items-center gap-2.5 rounded-xl px-3 text-[15.5px] outline-none data-[highlighted]:bg-[var(--stor-surface-muted)] {childActive ? 'bg-[var(--stor-accent-soft)] font-semibold text-[var(--stor-accent-strong)]' : 'font-medium text-[var(--stor-ink)]'}"
                            onSelect={() => void goto(childHref(phoneSection as NavLink, child))}
                        >
                            <span class="min-w-0 flex-1 truncate">{child.label}</span>
                            {#if childBadge}<span class="stor-dock-badge static {childBadge.tone === 'negative' ? 'stor-dock-badge-negative' : 'stor-dock-badge-warning'}" aria-label={childBadge.label}>{childBadge.count}</span>{/if}
                            {#if childActive}<IconCheck class="h-[18px] w-[18px] shrink-0" />{/if}
                        </DropdownMenu.Item>
                    {/each}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    {:else}
        <div class="flex min-w-0 shrink">{@render phoneTitleBlock(false)}</div>
    {/if}
    {#if !phoneHeader.selection}
    <div class="ml-auto flex min-w-0 items-center justify-end gap-2">
        {#if phoneHeader.glance}{@render phoneHeader.glance()}{/if}
        {#if !phoneHeader.hideLog}
            <LogStatusChip
                variant={inCopiedLog ? "pill" : "round"}
                {currentLogName}
                statusLine={syncShort}
                statusTitle={syncTitle}
                tone={syncTone}
                {version}
                pulsing={syncPhase === "syncing"}
                disabled={!dataReady}
                expanded={logTreeOpen}
                onOpen={openLogChip}
            />
        {/if}
    </div>
    {/if}
</header>

{#if isMoreOpen && NavMoreDialog}
    <NavMoreDialog
        open={isMoreOpen}
        {userEmail}
        links={moreNavLinks}
        settings={settingsLinks}
        {currentLogName}
        {syncLabel}
        {syncDescription}
        statusLine={syncLine}
        statusTitle={syncTitle}
        tone={syncTone}
        {version}
        pulsing={syncPhase === "syncing"}
        {dataReady}
        {offlineAvailable}
        onOpenChange={setMoreOpen}
        onOpenSyncIssues={onOpenSyncIssues}
        onOpenLogs={() => { setMoreOpen(false); openLogTree(); }}
    />
{/if}

<nav
    class="stor-mobile-nav fixed z-[55] grid md:hidden"
    style={`grid-template-columns: repeat(${mobilePrimaryLinks.length + 1}, minmax(0, 1fr))`}
    aria-label="Mobile navigation"
>
    {#each mobilePrimaryLinks as link}
        {@const Icon = link.icon}
        <!-- While the More sheet is open it owns the selection, so only one dock item looks selected. -->
        {@const active = isLinkActive(link) && !isMoreOpen}
        {@const badge = attention.badge(link.id)}
        <a
            href={linkHref(link.path)}
            class="group flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[10.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--stor-focus)] {active ? 'text-[var(--stor-accent-strong)]' : 'text-[var(--stor-muted-text)]'}"
            aria-current={active ? "page" : undefined}
            aria-label={badge ? `${link.label}, ${badge.label}` : undefined}
        >
            <span class="relative flex h-7 min-w-11 items-center justify-center rounded-full transition {active ? 'bg-[var(--stor-accent-soft)]' : 'group-active:bg-[var(--stor-surface-muted)]'}">
                <Icon class="h-[18px] w-[18px]" />
                {#if badge}<span class="stor-dock-badge {badge.tone === 'negative' ? 'stor-dock-badge-negative' : 'stor-dock-badge-warning'}" aria-hidden="true">{badge.count}</span>{/if}
            </span>
            <span class="max-w-full truncate px-0.5">{link.label}</span>
        </a>
    {/each}
    <button
        type="button"
        class="group relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[10.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--stor-focus)] {isMoreActive ? 'text-[var(--stor-accent-strong)]' : 'text-[var(--stor-muted-text)]'}"
        onclick={toggleMore}
        aria-current={activeMoreLink ? "page" : undefined}
        aria-label={moreButtonAriaLabel}
        aria-expanded={isMoreOpen}
    >
        <span class="relative flex h-7 min-w-11 items-center justify-center rounded-full transition {isMoreActive ? 'bg-[var(--stor-accent-soft)]' : 'group-active:bg-[var(--stor-surface-muted)]'}">
            <IconDots class="h-[18px] w-[18px]" />
            {#if showSyncDot}
                <span class="absolute right-1 top-0.5 h-2 w-2 rounded-full shadow-[0_0_0_2px_var(--stor-surface-raised)] {syncPresentation.tone === 'danger' ? 'bg-[var(--stor-negative)]' : 'bg-[var(--stor-warning)]'}" aria-hidden="true"></span>
            {/if}
        </span>
        {moreButtonLabel}
    </button>
</nav>
