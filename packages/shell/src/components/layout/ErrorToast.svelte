<script lang="ts">
    let {
        message,
        onDismiss,
    }: {
        message: string;
        onDismiss: () => void;
    } = $props();
</script>

<div
    class="fixed bottom-4 right-4 bg-red-500 text-white px-4 py-3 rounded-lg shadow-[var(--stor-elevation-3)] flex items-center space-x-3 max-w-sm z-50"
>
    <span class="flex-1 text-sm">{message}</span>
    <button
        onclick={onDismiss}
        class="shrink-0 text-white hover:text-red-100 focus:outline-none"
        aria-label="Dismiss error"
    >
        <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
        >
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
            ></path>
        </svg>
    </button>
</div>
