<script lang="ts">
    import ConfirmDialog from "@hearthlog/ui/components/ConfirmDialog.svelte";
    import Drawer from "@hearthlog/ui/components/Drawer.svelte";
    import EmptyState from "@hearthlog/ui/components/EmptyState.svelte";
    import DataPlaceholder from "@hearthlog/ui/components/data/DataPlaceholder.svelte";
    import Badge from "@hearthlog/ui/components/ui/Badge.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import Checkbox from "@hearthlog/ui/components/ui/Checkbox.svelte";
    import Field from "@hearthlog/ui/components/ui/Field.svelte";
    import Input from "@hearthlog/ui/components/ui/Input.svelte";
    import Select from "@hearthlog/ui/components/ui/Select.svelte";
    import { calendarSourceIcon } from "./source-icons.js";
    import {
        calendarMenuEntries,
        type CalendarMenuEntry,
    } from "@hearthlog/runtime/calendar/groups.js";
    import type { CalendarSourceInfo } from "@hearthlog/contracts/calendar/types";
    import {
        createCalendarFeed,
        listCalendarFeeds,
        revokeCalendarFeed,
        webcalUrl,
        type CalendarFeedSummary,
        type CalendarFeedWindow,
        type CreatedCalendarFeed,
    } from "@hearthlog/runtime/calendar/feeds.js";
    import { formatDistanceToNow } from "date-fns";
    import { requireActiveContext } from "@hearthlog/runtime/db/index.js";
    import { notify } from "@hearthlog/ui/state/notifications.svelte.js";
    import { untrack } from "svelte";
    import IconRss from "~icons/mdi/rss";
    import IconPlus from "~icons/mdi/plus";
    import IconArrowLeft from "~icons/mdi/arrow-left";
    import IconCheck from "~icons/mdi/check";
    import IconCheckCircle from "~icons/mdi/check-circle-outline";
    import IconContentCopy from "~icons/mdi/content-copy";
    import IconLinkOff from "~icons/mdi/link-off";

    let {
        show = $bindable(false),
        sources,
    }: { show: boolean; sources: CalendarSourceInfo[] } = $props();

    const formId = $props.id();

    const WINDOW_PRESETS: Array<{
        value: string;
        label: string;
        windowDays: CalendarFeedWindow;
    }> = [
        {
            value: "default",
            label: "6 months back, 18 months ahead",
            windowDays: { pastDays: 183, futureDays: 548 },
        },
        {
            value: "half",
            label: "1 month back, 6 months ahead",
            windowDays: { pastDays: 31, futureDays: 183 },
        },
        {
            value: "wide",
            label: "1 year back, 2 years ahead",
            windowDays: { pastDays: 365, futureDays: 730 },
        },
        {
            value: "future",
            label: "Future only, 1 year ahead",
            windowDays: { pastDays: 0, futureDays: 365 },
        },
    ];

    type View = "list" | "create" | "created";

    let view = $state<View>("list");
    let feeds = $state<CalendarFeedSummary[]>([]);
    let loading = $state(false);
    let busy = $state(false);
    let error = $state("");
    let created = $state<CreatedCalendarFeed | null>(null);
    let label = $state("");
    let windowPreset = $state("default");
    let selectedSources = $state<Set<string>>(new Set());
    let revokeId = $state<string | null>(null);
    let copied = $state(false);
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    let wasOpen = false;

    const title = $derived(view === "create" ? "New calendar feed" : "Calendar feeds");
    const description = $derived(
        view === "create"
            ? "Publish this log to a calendar app."
            : "Subscribe to this log from Google Calendar, Apple Calendar, or Thunderbird.",
    );
    const allSelected = $derived(
        sources.length > 0 && sources.every((source) => selectedSources.has(source.key)),
    );
    const canCreate = $derived(selectedSources.size > 0);
    const sourceEntries = $derived(calendarMenuEntries(sources));

    $effect(() => {
        if (show && !wasOpen) {
            wasOpen = true;
            openDrawer();
        } else if (!show && wasOpen) {
            wasOpen = false;
            closeDrawer();
        }
    });

    function openDrawer(): void {
        view = "list";
        created = null;
        error = "";
        busy = false;
        revokeId = null;
        label = "";
        windowPreset = "default";
        copied = false;
        // `sources` identity changes with every page refresh; untrack it so a
        // background sync cannot reset the form while the drawer is open.
        selectedSources = new Set(
            untrack(() => sources).map((source) => source.key),
        );
        void load();
    }

    function closeDrawer(): void {
        if (copyTimer) clearTimeout(copyTimer);
        copied = false;
        created = null;
        error = "";
        busy = false;
        revokeId = null;
    }

    async function load(): Promise<void> {
        loading = true;
        error = "";
        try {
            const context = await requireActiveContext();
            feeds = await listCalendarFeeds(context.logId);
        } catch (cause) {
            error = messageOf(cause);
        } finally {
            loading = false;
        }
    }

    async function create(): Promise<void> {
        if (busy || !canCreate) return;
        busy = true;
        error = "";
        try {
            const context = await requireActiveContext();
            const allKeys = sources.map((source) => source.key);
            const chosen = allKeys.filter((key) => selectedSources.has(key));
            const preset =
                WINDOW_PRESETS.find((item) => item.value === windowPreset) ??
                WINDOW_PRESETS[0];
            created = await createCalendarFeed(context.logId, {
                label: label.trim() || "Calendar feed",
                sources: chosen.length === allKeys.length ? null : chosen,
                windowDays: preset.windowDays,
            });
            feeds = [created.feed, ...feeds];
            view = "created";
            notify.success("Calendar feed created");
        } catch (cause) {
            error = messageOf(cause);
            notify.error(error);
        } finally {
            busy = false;
        }
    }

    async function revoke(): Promise<void> {
        const feedId = revokeId;
        if (!feedId || busy) return;
        revokeId = null;
        busy = true;
        try {
            const context = await requireActiveContext();
            await revokeCalendarFeed(context.logId, feedId);
            feeds = feeds.filter((feed) => feed.feedId !== feedId);
            notify.success("Calendar feed revoked");
        } catch (cause) {
            notify.error(messageOf(cause));
        } finally {
            busy = false;
        }
    }

    async function copyUrl(url: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            copied = true;
            if (copyTimer) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => (copied = false), 2000);
        } catch {
            notify.error("Could not copy the URL");
        }
    }

    function entrySelected(entry: CalendarMenuEntry): boolean {
        return entry.sourceKeys.every((key) => selectedSources.has(key));
    }

    function toggleSource(entry: CalendarMenuEntry, checked: boolean): void {
        const next = new Set(selectedSources);
        for (const key of entry.sourceKeys) {
            if (checked) next.add(key);
            else next.delete(key);
        }
        selectedSources = next;
    }

    function selectAllSources(): void {
        selectedSources = new Set(sources.map((source) => source.key));
    }

    function clearSources(): void {
        selectedSources = new Set();
    }

    function feedScope(feed: CalendarFeedSummary): string {
        if (!feed.sources) return "All sources";
        const count = feed.sources.length;
        return `${count} ${count === 1 ? "source" : "sources"}`;
    }

    function feedUsage(feed: CalendarFeedSummary): string {
        const createdLabel = `created ${formatDistanceToNow(new Date(feed.createdAt), { addSuffix: true })}`;
        const usedLabel = feed.lastAccessedAt
            ? `used ${formatDistanceToNow(new Date(feed.lastAccessedAt), { addSuffix: true })}`
            : "not used yet";
        return `${createdLabel} · ${usedLabel}`;
    }

    function messageOf(cause: unknown): string {
        return cause instanceof Error ? cause.message : "The request failed";
    }
</script>

<Drawer
    show={show}
    {title}
    {description}
    onClose={() => (show = false)}
>
    {#if view === "list"}
        <div class="space-y-4">
            {#if error}
                <div class="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--stor-negative-soft)] px-3 py-2">
                    <p class="min-w-0 flex-1 text-sm text-[var(--stor-negative)]" role="alert">{error}</p>
                    <Button variant="secondary" size="sm" onclick={() => void load()}>Retry</Button>
                </div>
            {/if}

            {#if loading && feeds.length === 0}
                <DataPlaceholder rows={3} label="Loading calendar feeds" />
            {:else if feeds.length === 0}
                <EmptyState
                    surface={false}
                    icon={IconRss}
                    title="No calendar feeds"
                    description="Subscribe to this log from your calendar app."
                >
                    <Button onclick={() => (view = "create")}><IconPlus class="h-4 w-4" /> New feed</Button>
                </EmptyState>
            {:else}
                <ul class="divide-y divide-[var(--stor-border)]">
                    {#each feeds as feed (feed.feedId)}
                        <li class="flex items-center gap-3 py-3">
                            <div class="min-w-0 flex-1">
                                <p class="truncate text-sm font-semibold text-[var(--stor-ink)]">{feed.label}</p>
                                <p class="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--stor-muted-text)]">
                                    <Badge>{feedScope(feed)}</Badge>
                                    <span>{feedUsage(feed)}</span>
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Revoke ${feed.label}`}
                                disabled={busy}
                                onclick={() => (revokeId = feed.feedId)}
                            ><IconLinkOff class="h-4 w-4" /></Button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    {:else if view === "create"}
        <form
            id={formId}
            class="space-y-5"
            onsubmit={(event) => {
                event.preventDefault();
                void create();
            }}
        >
            <button
                type="button"
                class="stor-section-link"
                onclick={() => (view = "list")}
            ><IconArrowLeft class="h-4 w-4" /> Back to feeds</button>

            {#if error}
                <p class="rounded-xl bg-[var(--stor-negative-soft)] px-3 py-2 text-sm text-[var(--stor-negative)]" role="alert">
                    {error}
                </p>
            {/if}

            <Field label="Label" htmlFor="calendar-feed-label">
                <Input id="calendar-feed-label" bind:value={label} placeholder="Calendar feed" />
            </Field>

            <Field label="Publish window" htmlFor="calendar-feed-window">
                <Select
                    id="calendar-feed-window"
                    value={windowPreset}
                    options={WINDOW_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
                    onValueChange={(value) => (windowPreset = value)}
                />
            </Field>

            <section class="space-y-2" aria-labelledby="calendar-feed-sources-heading">
                <div class="flex items-center justify-between">
                    <h3 id="calendar-feed-sources-heading" class="text-xs font-semibold uppercase tracking-wide text-[var(--stor-muted-text)]">Sources</h3>
                    <button
                        type="button"
                        class="text-xs font-semibold text-[var(--stor-accent-text)] hover:underline"
                        onclick={allSelected ? clearSources : selectAllSources}
                    >{allSelected ? "Clear all" : "Select all"}</button>
                </div>
                <div class="grid gap-1 sm:grid-cols-2">
                    {#each sourceEntries as entry (entry.id)}
                        {@const Icon = calendarSourceIcon(entry.icon)}
                        <label class="flex min-h-11 items-center gap-2.5 rounded-xl px-2 text-sm text-[var(--stor-ink)] transition-colors hover:bg-[var(--stor-surface-muted)] sm:min-h-9">
                            <Checkbox
                                checked={entrySelected(entry)}
                                onCheckedChange={(checked) => toggleSource(entry, Boolean(checked))}
                                aria-label={entry.label}
                            />
                            <Icon class="h-4 w-4 shrink-0 text-[var(--stor-muted-text)]" />
                            <span class="truncate">{entry.label}</span>
                        </label>
                    {/each}
                </div>
                {#if !canCreate}
                    <p class="text-xs text-[var(--stor-negative)]" role="alert">Choose at least one source.</p>
                {/if}
            </section>
        </form>
    {:else if created}
        {@const feedUrl = created.url}
        <div class="space-y-5">
            <div class="flex items-center gap-3" role="status">
                <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--stor-positive-soft)] text-[var(--stor-positive)]">
                    <IconCheckCircle class="h-5 w-5" />
                </span>
                <div class="min-w-0">
                    <h3 class="text-base font-semibold text-[var(--stor-ink)]">Feed created</h3>
                    <p class="mt-0.5 text-sm text-[var(--stor-muted-text)]">Copy the URL now — it is not shown again.</p>
                </div>
            </div>

            <div class="flex gap-2">
                <Input
                    readonly
                    aria-label="Feed URL"
                    value={feedUrl}
                    class="font-mono text-xs"
                />
                <Button
                    variant={copied ? "secondary" : "default"}
                    aria-label={copied ? "Copied" : "Copy feed URL"}
                    onclick={() => copyUrl(feedUrl)}
                >
                    {#if copied}<IconCheck class="h-4 w-4" /> Copied{:else}<IconContentCopy class="h-4 w-4" /> Copy{/if}
                </Button>
            </div>

            <a class="stor-section-link" href={webcalUrl(feedUrl)}>Add to Apple Calendar</a>
        </div>
    {/if}

    {#snippet footer()}
        {#if view === "list"}
            <Button variant="secondary" onclick={() => (show = false)}>Close</Button>
            {#if feeds.length > 0}
                <Button onclick={() => (view = "create")}><IconPlus class="h-4 w-4" /> New feed</Button>
            {/if}
        {:else if view === "create"}
            <Button variant="secondary" onclick={() => (view = "list")}>Cancel</Button>
            <Button type="submit" form={formId} disabled={busy || !canCreate}>
                {busy ? "Creating…" : "Create feed"}
            </Button>
        {:else}
            <Button onclick={() => (view = "list")}>Done</Button>
        {/if}
    {/snippet}
</Drawer>

<ConfirmDialog
    show={revokeId !== null}
    title="Revoke feed?"
    message="Calendar clients using this URL stop updating immediately."
    confirmLabel="Revoke"
    tone="danger"
    onConfirm={revoke}
    onCancel={() => (revokeId = null)}
/>
