<script lang="ts">
    import { onMount } from "svelte";
    import { formatJson, scheduleJsonHighlight } from "./json-viewer.js";

    let {
        value,
        label = "JSON",
        maxHeight = "24rem",
    }: {
        value: unknown;
        label?: string;
        maxHeight?: string;
    } = $props();

    const formattedJson = $derived(formatJson(value));
    const lineCount = $derived(formattedJson.split("\n").length);
    const lineNumberWidth = $derived(
        Math.max(2, String(lineCount).length) + 2,
    );
    const lineNumbers = $derived(
        Array.from({ length: lineCount }, (_, index) => index + 1),
    );

    $effect(() => {
        formattedJson;
        scheduleJsonHighlight();
    });

    onMount(() => {
        scheduleJsonHighlight();
        return scheduleJsonHighlight;
    });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable code must be keyboard accessible.) -->
<div
    class="json-viewer overflow-auto rounded-xl stor-well"
    style:max-height={maxHeight}
    role="region"
    aria-label={label}
    tabindex="0"
    data-json-viewer
>
    <div class="json-code-shell">
        <div
            class="json-line-numbers py-3 font-mono text-[11px] leading-5 sm:text-xs"
            style={`width: ${lineNumberWidth}ch`}
            aria-hidden="true"
        >{#each lineNumbers as lineNumber}<span class="json-line-number">{lineNumber}</span>{/each}</div>
        <pre class="json-code min-w-max py-3 font-mono text-[11px] leading-5 sm:text-xs"><code class="language-json">{formattedJson}</code></pre>
    </div>
</div>

<style>
    .json-viewer {
        color: var(--stor-ink);
        scrollbar-color: var(--stor-field-border) var(--stor-surface-muted);
    }

    .json-viewer:focus-visible {
        outline: 2px solid var(--stor-accent);
        outline-offset: 2px;
    }

    .json-code-shell {
        display: flex;
        min-width: max-content;
    }

    .json-line-numbers {
        position: sticky;
        left: 0;
        z-index: 1;
        flex: 0 0 auto;
        box-sizing: border-box;
        border-right: 1px solid var(--stor-border);
        background: var(--stor-surface-muted);
        padding-right: 1.25ch;
        color: var(--stor-muted-text);
        text-align: right;
        user-select: none;
        white-space: pre;
    }

    .json-line-number {
        display: block;
    }

    .json-code {
        margin: 0;
        padding-inline: 1rem;
    }

    :global(::highlight(key)) {
        color: var(--stor-code-key);
    }

    :global(::highlight(string)) {
        color: var(--stor-code-string);
    }

    :global(::highlight(numeric)) {
        color: var(--stor-code-number);
    }

    :global(::highlight(boolean)) {
        color: var(--stor-code-literal);
    }

    :global(::highlight(constant)) {
        color: var(--stor-muted-text);
    }
</style>
