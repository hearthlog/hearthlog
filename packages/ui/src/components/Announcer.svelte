<script lang="ts">
    import { announcer } from '../state/announcer.svelte.js';
</script>

<!-- One per page, in the layout: the polite live region figures announce through. -->
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcer.message}</div>
