<script lang="ts">
    const drawerId = $props.id();
    const drawerFormId0 = drawerId + "-0";

    import { tick } from "svelte";
    import Drawer from "@hearthlog/ui/components/Drawer.svelte";
    import Button from "@hearthlog/ui/components/ui/Button.svelte";
    import Input from "@hearthlog/ui/components/ui/Input.svelte";
    import Label from "@hearthlog/ui/components/ui/Label.svelte";

    let {
        show,
        onClose,
        onCreate,
    }: {
        show: boolean;
        onClose: () => void;
        onCreate: (name: string) => Promise<void>;
    } = $props();

    let name = $state("");
    let saving = $state(false);
    let errorMessage = $state("");
    let opened = false;

    $effect(() => {
        if (!show) {
            opened = false;
            return;
        }
        if (opened) return;
        opened = true;
        name = "";
        errorMessage = "";
        void tick().then(() => {
            document.querySelector<HTMLInputElement>(
                '[data-testid="new-log-name"]',
            )?.focus();
        });
    });

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (saving) return;

        const trimmedName = name.trim();
        if (!trimmedName) {
            errorMessage = "Enter a log name.";
            return;
        }

        saving = true;
        errorMessage = "";
        try {
            await onCreate(trimmedName);
            onClose();
        } catch (error) {
            errorMessage =
                error instanceof Error
                    ? error.message
                    : "The log could not be created.";
        } finally {
            saving = false;
        }
    }
</script>

<Drawer
    {show}
    title="Create new log"
    description="Create an empty event log and start using it immediately."
    {onClose}
>
    <form id={drawerFormId0} class="space-y-4" onsubmit={submit}>
        <Label class="block">
            Log name
            <Input
                data-testid="new-log-name"
                bind:value={name}
                placeholder="Personal, work, archive..."
                autocomplete="off"
                class="mt-1.5"
                disabled={saving}
            />
        </Label>

        <p class="text-xs leading-5 text-[var(--stor-muted-text)]">
            The new log will become the active log in this browser. Existing logs
            remain unchanged.
        </p>

        {#if errorMessage}
            <div
                class="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                role="alert"
            >
                {errorMessage}
            </div>
        {/if}

        </form>
    {#snippet footer()}
            <Button variant="secondary" size="sm" onclick={onClose} disabled={saving}>
                Cancel
            </Button>
            <Button type="submit" form={drawerFormId0} size="sm" disabled={saving || !name.trim()}>
                {saving ? "Creating..." : "Create log"}
            </Button>

    {/snippet}
</Drawer>
