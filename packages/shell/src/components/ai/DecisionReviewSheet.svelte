<script lang="ts">
    import { untrack } from "svelte";
    import CommandDrawer from "@hearthlog/ui/components/commands/CommandDrawer.svelte";
    import DataPlaceholder from "@hearthlog/ui/components/data/DataPlaceholder.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import Checkbox from "@hearthlog/ui/components/ui/Checkbox.svelte";
    import Select, { type SelectOption } from "@hearthlog/ui/components/ui/Select.svelte";
    import SuggestionChip from "./SuggestionChip.svelte";
    import SuggestionMark from "./SuggestionMark.svelte";

    /**
     * Reviews a backlog of rows that still lack one value (a category, an
     * expense type). Each row shows a suggestion: a history match or a
     * confident model pick is filled and ticked, a less sure pick is a chip,
     * and the rest says Choose. Apply hands the ticked rows to the page as one
     * action; nothing is written here.
     */

    export interface ReviewRow {
        id: string;
        title: string;
        /** One support line under the title. */
        meta: string;
    }

    export interface ReviewSuggestion {
        value: string;
        /** The value's label, for the chip. */
        label: string;
        kind: "ai" | "history";
        /** A plain reason for a history match; empty for a model's pick. */
        reason: string;
        band: "apply" | "offer";
        /** What the page stores as provenance when the value is kept. */
        source: string;
    }

    export interface ReviewItem {
        row: ReviewRow;
        previous: { value: string; source: string };
        suggestion: ReviewSuggestion | null;
    }

    export interface ReviewChange {
        id: string;
        value: string;
        source: string;
        previous: { value: string; source: string };
    }

    interface Entry extends ReviewRow {
        previous: { value: string; source: string };
        choice: string;
        source: string;
        ticked: boolean;
        applied: ReviewSuggestion | null;
        offered: ReviewSuggestion | null;
    }

    let {
        show,
        title,
        description = "",
        fieldLabel,
        options,
        unsetValue,
        emptyText,
        loadingLabel,
        applyTestId = "apply-suggestions",
        loadKey,
        load,
        onClose,
        onApply,
    }: {
        show: boolean;
        title: string;
        description?: string;
        /** What is being chosen, for accessible names ("Category"). */
        fieldLabel: string;
        /** Includes the unset option, labelled Choose. */
        options: SelectOption[];
        /** The option value that means nothing is chosen yet. */
        unsetValue: string;
        emptyText: string;
        loadingLabel: string;
        applyTestId?: string;
        /** Reloads the rows while the sheet is open when this changes. */
        loadKey: string;
        load: () => Promise<ReviewItem[]>;
        onClose: () => void;
        /** Writes every change in one action. Throws when saving fails. */
        onApply: (changes: ReviewChange[]) => Promise<void>;
    } = $props();

    let entries = $state<Entry[]>([]);
    let loading = $state(false);
    let busy = $state(false);
    let errorMessage = $state("");
    let run = 0;

    const ticked = $derived(entries.filter((entry) => entry.ticked));

    $effect(() => {
        void loadKey;
        if (!show) {
            run += 1;
            return;
        }
        void untrack(() => reload());
    });

    async function reload(): Promise<void> {
        const current = ++run;
        loading = true;
        errorMessage = "";
        entries = [];
        try {
            const items = await load();
            // The sheet may have closed or moved on while the model was thinking.
            if (current !== run) return;
            entries = items.map(({ row, previous, suggestion }) => {
                const apply = suggestion?.band === "apply";
                return {
                    ...row,
                    previous,
                    choice: apply ? suggestion!.value : unsetValue,
                    source: apply ? suggestion!.source : "",
                    ticked: apply,
                    applied: apply ? suggestion! : null,
                    offered: suggestion && !apply ? suggestion : null,
                };
            });
        } catch (error) {
            if (current !== run) return;
            console.error(`[AI] Could not load rows for "${title}":`, error);
            errorMessage = "The rows could not be loaded.";
        } finally {
            if (current === run) loading = false;
        }
    }

    function choose(entry: Entry, value: string): void {
        entry.choice = value;
        entry.source = value === unsetValue ? "" : "manual";
        entry.ticked = value !== unsetValue;
        entry.applied = null;
        entry.offered = null;
    }

    function takeOffer(entry: Entry): void {
        const offer = entry.offered;
        if (!offer) return;
        entry.choice = offer.value;
        entry.source = offer.source;
        entry.applied = offer;
        entry.offered = null;
        entry.ticked = true;
    }

    async function apply(): Promise<void> {
        if (busy || ticked.length === 0) return;
        busy = true;
        errorMessage = "";
        try {
            await onApply(ticked.map((entry) => ({ id: entry.id, value: entry.choice, source: entry.source, previous: entry.previous })));
        } catch {
            // The ticks stay, so the same Apply can be retried.
            errorMessage = "The changes could not be saved. Your choices are still here.";
        } finally {
            busy = false;
        }
    }
</script>

<CommandDrawer {show} {title} {description} size="lg" onClose={() => { if (!busy) onClose(); }}>
    {#if loading}
        <DataPlaceholder rows={6} label={loadingLabel} />
    {:else if entries.length === 0}
        <p class="text-sm text-[var(--stor-muted-text)]">{errorMessage || emptyText}</p>
    {:else}
        <ul class="divide-y divide-[var(--stor-border)]" aria-label={title}>
            {#each entries as entry (entry.id)}
                <li class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_12rem]">
                    <Checkbox
                        checked={entry.ticked}
                        disabled={busy || entry.choice === unsetValue}
                        onCheckedChange={(value) => (entry.ticked = value === true)}
                        aria-label={`Apply ${fieldLabel.toLowerCase()} to ${entry.title}`}
                    />
                    <div class="min-w-0">
                        <div class="truncate text-sm font-medium text-[var(--stor-ink)]">{entry.title}</div>
                        <div class="truncate text-xs text-[var(--stor-muted-text)] tabular-nums">{entry.meta}</div>
                    </div>
                    <div class="col-start-2 min-w-0 sm:col-start-3">
                        <Select
                            value={entry.choice}
                            {options}
                            disabled={busy}
                            ariaLabel={`${fieldLabel} for ${entry.title}`}
                            onValueChange={(value) => choose(entry, value)}
                        />
                    </div>
                    {#if entry.applied || entry.offered}
                        <div class="col-start-2 flex min-h-5 items-center sm:col-span-3 sm:col-start-2" aria-live="polite">
                            {#if entry.applied}
                                <SuggestionMark kind={entry.applied.kind} reason={entry.applied.reason} />
                            {:else if entry.offered}
                                <SuggestionChip label={entry.offered.label} disabled={busy} onclick={() => takeOffer(entry)} />
                            {/if}
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
        {#if errorMessage}
            <div class="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{errorMessage}</div>
        {/if}
    {/if}

    {#snippet footer()}
        <Button variant="secondary" size="sm" onclick={onClose} disabled={busy}>Cancel</Button>
        <Button data-testid={applyTestId} disabled={busy || ticked.length === 0} onclick={() => void apply()}>
            {busy ? "Saving..." : ticked.length === 0 ? "Apply" : `Apply ${ticked.length}`}
        </Button>
    {/snippet}
</CommandDrawer>
