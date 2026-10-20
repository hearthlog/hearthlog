<script lang="ts">
    import { onMount } from "svelte";
    import { tenant } from "@hearthlog/contracts/tenant/config";
    import { startNativeEngine } from "@hearthlog/runtime/native/engine.svelte.js";
    import { startWorkspaceSync } from "../layout/workspace-sync.js";

    /**
     * The native engine route (`ENGINE_PATH`): a native app loads it in a hidden web view and reads
     * the runtime through the bridge. It opens and syncs the workspace like the shell layout and
     * shows nothing. Module startups are left out: they mount page UI or move files, which the
     * app's own windows or the web app do.
     */
    const { data }: { data: { workspace: { ready: Promise<{ schemaRebuilt: boolean }> } } } = $props();

    onMount(() => {
        // The engine first: it tells the runtime the page is active before sync looks.
        const stopEngine = startNativeEngine(data.workspace.ready);
        const stopSync = startWorkspaceSync(data.workspace);
        return () => {
            stopSync();
            stopEngine();
        };
    });
</script>

<svelte:head>
    <title>{tenant.title} engine</title>
</svelte:head>
