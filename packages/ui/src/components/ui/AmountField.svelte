<script lang="ts">
    import type { HTMLInputAttributes } from "svelte/elements";
    import { cn } from "../../utils/cn.js";
    import { formatAmount, parseAmount } from "../../utils/number-format.js";

    type Direction = "expense" | "income";

    /**
     * A money amount at display size: the figure, its currency after it, and the Expense/Income toggle inside
     * the field, so direction never comes from a minus sign. A simple sum ("1200+84") resolves on blur or Enter;
     * a plain number counts as it is typed. `value` is the amount (never negative), `null` while the field is
     * empty or unreadable. Put it in a `Field` for its label, help and error.
     */
    let {
        value = $bindable(null),
        direction = $bindable("expense"),
        currency = "Kč",
        directions = true,
        invalid = false,
        disabled = false,
        placeholder = "0",
        onValueChange,
        oninput,
        onblur,
        onkeydown,
        class: className = "",
        ...restProps
    }: Omit<HTMLInputAttributes, "value" | "type" | "class"> & {
        value?: number | null;
        direction?: Direction;
        currency?: string;
        /** Shows the Expense/Income toggle; off for amounts that have no direction. */
        directions?: boolean;
        invalid?: boolean;
        onValueChange?: (value: number | null) => void;
        class?: string;
    } = $props();

    const OPERATOR = /.[+\-−–]/;

    /** What the person typed, while it differs from the formatted value; null shows the value itself. */
    let draft = $state<string | null>(null);
    let unreadable = $state(false);
    const shown = $derived(draft ?? (value === null || value === undefined ? "" : formatAmount(value)));

    function commit(next: number | null) {
        if (next === value) return;
        value = next;
        onValueChange?.(next);
    }

    function input(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
        oninput?.(event);
        draft = event.currentTarget.value;
        unreadable = false;
        if (!draft.trim()) return commit(null);
        if (OPERATOR.test(draft)) return;
        const parsed = parseAmount(draft);
        if (parsed !== null && parsed >= 0) commit(parsed);
    }

    /** Resolves a sum and puts the figure back in its Czech form; an unreadable entry stays for correcting. */
    function resolve() {
        if (draft === null) return;
        if (!draft.trim()) {
            draft = null;
            return commit(null);
        }
        const parsed = parseAmount(draft);
        if (parsed === null || parsed < 0) {
            unreadable = true;
            return commit(null);
        }
        unreadable = false;
        draft = null;
        commit(parsed);
    }

    function blur(event: FocusEvent & { currentTarget: EventTarget & HTMLInputElement }) {
        resolve();
        onblur?.(event);
    }

    function keydown(event: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }) {
        // Before a form submits or a sheet's ⌘↵ presses its action, so they read the resolved sum.
        if (event.key === "Enter") resolve();
        onkeydown?.(event);
    }
</script>

<div
    class={cn("stor-field-control stor-amount-field flex min-h-[76px] flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] px-4 py-3", className)}
    data-stor-invalid={invalid || unreadable ? "" : undefined}
    data-disabled={disabled ? "" : undefined}
>
    {#if directions}
        <div class="stor-segmented-control inline-flex shrink-0" role="group" aria-label="Direction">
            <button type="button" class="stor-segmented-option inline-flex items-center gap-1" aria-pressed={direction === "expense"} {disabled} onclick={() => (direction = "expense")}><span aria-hidden="true">−</span>Expense</button>
            <button type="button" class="stor-segmented-option inline-flex items-center gap-1" aria-pressed={direction === "income"} {disabled} onclick={() => (direction = "income")}><span aria-hidden="true">+</span>Income</button>
        </div>
    {/if}
    <div class="flex min-w-[9rem] flex-1 items-baseline gap-3">
        <input
            type="text"
            inputmode="decimal"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="done"
            class="w-full min-w-0 flex-1 bg-transparent p-0 text-display text-[var(--stor-ink)] placeholder:text-[var(--stor-faint-text)]"
            value={shown}
            {placeholder}
            {disabled}
            {...restProps}
            aria-invalid={invalid || unreadable || undefined}
            oninput={input}
            onblur={blur}
            onkeydown={keydown}
        />
        {#if currency}<span class="shrink-0 text-lg font-semibold text-[var(--stor-muted-text)]">{currency}</span>{/if}
    </div>
</div>

<style>
    /* The field draws focus around the whole amount, so the figure itself takes no outline. */
    input:focus-visible { outline: none; }
    input { font-feature-settings: "tnum", "ss01"; }
    .stor-amount-field :global(.stor-segmented-option) { min-height: 32px; }
</style>
