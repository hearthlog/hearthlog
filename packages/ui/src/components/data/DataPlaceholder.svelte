<script lang="ts">
    let { rows = 3, label = 'Loading data', compact = false }: { rows?: number; label?: string; compact?: boolean } = $props();
</script>
<div class="grid {compact ? 'gap-2' : 'gap-3 p-5'}" role="status" aria-label={label}>
    {#each Array(rows) as _, i}
        <div class="{compact ? 'h-5' : 'h-8'} rounded-lg bg-[var(--stor-surface-muted)] motion-safe:animate-pulse" style:width={`${100 - (i % 3) * 12}%`} aria-hidden="true"></div>
    {/each}
</div>
