<script lang="ts">
    import type { ReferencedByResult } from "@hearthlog/runtime/event/reference-lookup.js";

    let {
        refs,
        entityHref,
    }: {
        refs?: ReferencedByResult | null;
        entityHref: (name: string) => string;
    } = $props();
</script>

{#if refs && refs.totalCount > 0}
    <div class="group/refs relative inline-block">
        <span
            class="cursor-help rounded-full bg-[var(--stor-accent-soft)] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wide text-[var(--stor-accent-strong)]"
        >
            {refs.totalCount} ref{refs.totalCount !== 1 ? "s" : ""}
        </span>
        <div
            class="absolute bottom-full left-0 z-20 mb-2 hidden group-hover/refs:block"
        >
            <div
                class="stor-menu min-w-[180px] border border-[var(--stor-border)] p-3 text-xs"
            >
                <div class="mb-2 font-bold text-[var(--stor-ink)]">
                    Referenced by:
                </div>
                {#each Object.entries(refs.byType) as [typeName, entities]}
                    <div class="mb-1.5">
                        <span class="font-semibold text-[var(--stor-accent-strong)]"
                            >{typeName}</span
                        >
                        <ul class="mt-0.5 pl-2">
                            {#each entities.slice(0, 5) as ref}
                                <li class="text-[var(--stor-muted-text)]">
                                    <a
                                        href={entityHref(ref.entityType)}
                                        class="transition hover:text-[var(--stor-ink)] hover:underline"
                                    >
                                        {ref.entityLabel}
                                    </a>
                                </li>
                            {/each}
                            {#if entities.length > 5}
                                <li class="italic text-[var(--stor-muted-text)]">
                                    +{entities.length - 5} more
                                </li>
                            {/if}
                        </ul>
                    </div>
                {/each}
            </div>
        </div>
    </div>
{:else}
    <span class="text-xs text-[var(--stor-muted-text)]">—</span>
{/if}
