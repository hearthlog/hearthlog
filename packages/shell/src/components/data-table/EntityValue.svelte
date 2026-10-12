<script lang="ts">
    import type { DynamicFieldDefinition } from "@hearthlog/runtime/event/meta-entity-types.js";

    let {
        value,
        field,
        referenceLabel = null,
    }: {
        value: unknown;
        field: DynamicFieldDefinition;
        referenceLabel?: string | null;
    } = $props();

    const text = $derived.by(() => {
        if (value === null || value === undefined) return "-";
        if (field.type === "boolean") return value ? "✓" : "✗";
        if (field.type === "datetime" && value) {
            try {
                return new Date(value as string).toLocaleString();
            } catch {
                return String(value);
            }
        }
        if (field.type === "reference" && referenceLabel) return referenceLabel;
        return String(value);
    });
    const truthy = $derived(Boolean(value));
</script>

{#if field.type === "boolean"}
    <span
        class="rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase {truthy
            ? 'bg-[var(--stor-positive-soft)] text-[var(--stor-positive)]'
            : 'bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]'}"
    >
        {text}
    </span>
{:else if field.type === "number"}
    <span class="font-mono font-medium text-[var(--stor-ink)]">{text}</span>
{:else}
    <span class="whitespace-pre-wrap break-words">{text}</span>
{/if}
