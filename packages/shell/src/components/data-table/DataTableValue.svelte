<script lang="ts">
    import type { RawSqliteValuePresentation } from "@hearthlog/runtime/db/raw-browser.js";

    let { presented }: { presented: RawSqliteValuePresentation } = $props();
</script>

<span
    class:italic={presented.kind === "null"}
    class:text-[var(--stor-muted-text)]={presented.kind === "null"}
    class:text-violet-700={presented.kind === "blob"}
    class="whitespace-pre-wrap break-words"
>
    {presented.text}
</span>
