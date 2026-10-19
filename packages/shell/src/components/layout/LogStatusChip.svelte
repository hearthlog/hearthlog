<script lang="ts" module>
    export type LogStatusTone = 'neutral' | 'success' | 'warning' | 'danger';
</script>

<script lang="ts">
    import Tooltip from '@hearthlog/ui/components/ui/Tooltip.svelte';
    import { formatNumber } from '@hearthlog/ui/utils/number-format.js';
    import IconLayers from '~icons/mdi/layers-outline';
    import IconUnfold from '~icons/mdi/unfold-more-horizontal';

    let {
        currentLogName,
        statusLine,
        statusTitle,
        tone,
        version = null,
        pulsing = false,
        variant = 'foot',
        expanded = false,
        disabled = false,
        note,
        onOpen,
    }: {
        currentLogName: string | null;
        /** Short sync state, e.g. "Saved on this device · synced 12:09". */
        statusLine: string;
        /** Full sync sentence for the tooltip and accessible description. */
        statusTitle: string;
        tone: LogStatusTone;
        /** Head version of the active log; hidden when the log has no changes yet. */
        version?: number | null;
        pulsing?: boolean;
        /** `foot` in the sidebar, `tile` in the collapsed rail, `row` in the phone sheet, `pill` or `round` in the phone top bar. */
        variant?: 'foot' | 'tile' | 'row' | 'pill' | 'round';
        expanded?: boolean;
        disabled?: boolean;
        /** A small positive tag at the end of a `row`, such as "Available offline". */
        note?: string;
        onOpen: () => void;
    } = $props();

    const logLabel = $derived(currentLogName || (disabled ? 'Loading log…' : 'Choose a log'));
    const versionLabel = $derived(version !== null && version > 0 ? `v${formatNumber(version)}` : null);
    const descriptionId = $props.id();
    const danger = $derived(tone === 'danger');
    // Sync that is fine stays silent. A dot marks the exception: saving, offline or needing review.
    const showDot = $derived(tone !== 'success');
    const dotClass = $derived({
        success: 'bg-[var(--stor-positive)]',
        warning: 'bg-[var(--stor-warning)]',
        danger: 'bg-[var(--stor-negative)]',
        neutral: 'bg-[var(--stor-surface)] ring-2 ring-inset ring-[var(--stor-muted-text)]',
    }[tone]);
    // The ring around the dot matches the surface the tile sits on.
    const ringClass = $derived(
        variant === 'row'
            ? 'shadow-[0_0_0_2px_var(--stor-surface-muted)]'
            : 'shadow-[0_0_0_2px_var(--stor-sidebar)]',
    );
</script>

{#snippet versionTag()}
    {#if versionLabel}
        <span class="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--stor-ink)_8%,transparent)] px-1.5 text-[10px] font-semibold leading-4 tabular-nums {danger ? '' : 'text-[var(--stor-muted-text)]'}">{versionLabel}</span>
    {/if}
{/snippet}

{#snippet chip(tip: Record<string, unknown> = {})}
    <button
        {...tip}
        type="button"
        class="stor-log-chip group flex items-center text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:cursor-wait disabled:opacity-60 {variant === 'foot'
            ? 'w-full gap-2.5 rounded-xl p-1.5'
            : variant === 'row'
              ? 'w-full gap-2.5 rounded-2xl py-2 pl-2 pr-2.5'
              : variant === 'tile'
                ? 'mx-auto h-11 w-11 justify-center rounded-xl'
                : variant === 'round'
                  ? 'relative h-10 w-10 shrink-0 justify-center rounded-full'
                : 'h-9 min-w-0 max-w-full gap-2 rounded-full pl-2.5 pr-2 text-xs font-semibold'} {danger
            ? 'bg-[var(--stor-negative-soft)] text-[var(--stor-negative)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--stor-negative),transparent_70%)]'
            : variant === 'pill' || variant === 'round'
              ? 'bg-[var(--stor-surface-raised)] text-[var(--stor-ink)] shadow-[var(--stor-shadow-sm)] hover:shadow-[var(--stor-shadow-md)]'
              : variant === 'row'
                ? 'bg-[var(--stor-surface-muted)] text-[var(--stor-ink)]'
                : 'text-[var(--stor-ink)] hover:bg-[var(--stor-nav-hover)]'}"
        title={variant === 'tile' ? undefined : `${logLabel}${versionLabel ? ` ${versionLabel}` : ''} · ${statusTitle}`}
        aria-label={currentLogName ? `Active log: ${currentLogName}` : 'Open your logs'}
        aria-describedby={descriptionId}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        {disabled}
        onclick={(event) => {
            (tip.onclick as ((event: MouseEvent) => void) | undefined)?.(event);
            onOpen();
        }}
        data-testid="log-status-chip"
        data-tone={tone}
    >
        <span id={descriptionId} class="sr-only">{versionLabel ? `${statusTitle} Log version ${version}.` : statusTitle}</span>
        {#if variant === 'round'}
            <IconLayers class="h-[18px] w-[18px] text-[var(--stor-muted-text)]" />
            {#if showDot}<span class="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full {dotClass} {pulsing ? 'motion-safe:animate-pulse' : ''} shadow-[0_0_0_2px_var(--stor-surface-raised)]" aria-hidden="true"></span>{/if}
        {:else if variant === 'pill'}
            {#if showDot}<span class="h-2 w-2 shrink-0 rounded-full {dotClass} {pulsing ? 'motion-safe:animate-pulse' : ''}" aria-hidden="true"></span>{/if}
            <span class="min-w-0 truncate">{logLabel}</span>
            {@render versionTag()}
            <span class="hidden shrink-0 font-medium opacity-70 min-[380px]:inline">· {statusLine}</span>
            <IconUnfold class="h-3.5 w-3.5 shrink-0 opacity-60" />
        {:else}
            <span class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] {danger ? 'bg-[color-mix(in_srgb,var(--stor-negative),transparent_85%)]' : 'bg-[var(--stor-accent-soft)] text-[var(--stor-accent-strong)]'}">
                <IconLayers class="h-4 w-4" />
                {#if showDot}<span class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full {dotClass} {pulsing ? 'motion-safe:animate-pulse' : ''} {ringClass}" aria-hidden="true"></span>{/if}
            </span>
            {#if variant !== 'tile'}
                <span class="flex min-w-0 flex-1 flex-col leading-tight">
                    <span class="flex min-w-0 items-center gap-1.5">
                        <span class="truncate text-[13px] font-semibold">{logLabel}</span>
                        {@render versionTag()}
                    </span>
                    <span class="line-clamp-2 text-[11px] {danger ? '' : 'text-[var(--stor-muted-text)]'}">{statusLine}</span>
                </span>
                {#if note}<span class="shrink-0 text-[11px] font-semibold text-[var(--stor-positive)]">{note}</span>{/if}
                <IconUnfold class="h-4 w-4 shrink-0 {danger ? '' : 'text-[var(--stor-muted-text)]'}" />
            {/if}
        {/if}
    </button>
{/snippet}

{#if variant === 'tile'}
    <!-- The rail has no label, so the tile names the log and its sync state in a tooltip. -->
    <Tooltip content={`${logLabel}${versionLabel ? ` ${versionLabel}` : ''}: ${statusLine}`} side="right" delayDuration={150}>
        {#snippet trigger({ props })}{@render chip(props)}{/snippet}
    </Tooltip>
{:else}
    {@render chip()}
{/if}
