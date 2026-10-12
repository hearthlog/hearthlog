<script lang="ts">
    let { pendingCount }: { pendingCount: number } = $props();
</script>

{#if pendingCount > 0}
    <div
        class="fixed bottom-4 left-4 bg-amber-500 text-white px-3 py-2 rounded-lg shadow-[var(--stor-elevation-3)] flex items-center space-x-2 z-50"
    >
        <svg
            class="w-4 h-4 animate-pulse"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
        >
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            ></path>
        </svg>
        <span class="text-sm font-medium">{pendingCount} pending</span>
    </div>
{/if}
