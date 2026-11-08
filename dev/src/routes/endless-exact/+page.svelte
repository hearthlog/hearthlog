<script lang="ts">
    // Fixture for tests/endless.spec.ts: blocks whose height equals the estimate exactly.
    import EndlessList from '@hearthlog/ui/components/endless/EndlessList.svelte';
    import { BucketStore } from '@hearthlog/ui/components/endless/bucket-store.svelte.js';
    import { listAxis } from '@hearthlog/ui/utils/endless-axis.js';

    const ROW = 40;
    const ROWS = 30;
    const keys = Array.from({ length: 5 }, (_, index) => `block-${index}`);
    const axis = listAxis(keys);
    const store = new BucketStore<number>(
        async (wanted) => new Map(wanted.map((key) => [key, ROWS])),
        'Could not load blocks',
    );
</script>

<div class="h-[480px]">
    <EndlessList
        {axis}
        {store}
        estimate={ROW * ROWS}
        opening={{ key: 'block-2', find: (block) => block.querySelector<HTMLElement>('[data-row="20"]') }}
        class="h-full" data-test-scroll
    >
        {#snippet openingPlaceholder()}
            <div role="status">Loading</div>
        {/snippet}
        {#snippet item(key, rows)}
            <section style:height="{ROW * ROWS}px">
                {#each { length: rows ?? 0 } as _, row}
                    <div data-row={row} style:height="{ROW}px">{key} row {row}</div>
                {/each}
            </section>
        {/snippet}
    </EndlessList>
</div>
