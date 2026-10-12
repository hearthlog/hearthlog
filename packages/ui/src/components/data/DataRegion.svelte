<script lang="ts">
    import type { Snippet } from 'svelte';
    import { providePageResource } from '../../state/page-context.js';
    let { loading, children }: { loading: boolean; children: Snippet } = $props();
    providePageResource(() => ({ loading }));
</script>

{@render children()}
