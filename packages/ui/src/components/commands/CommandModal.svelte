<script lang="ts">
    import type { Snippet } from "svelte";
    import Modal from "../Modal.svelte";
    import CommandOnly from "./CommandOnly.svelte";

    let {
        show = false,
        title = "",
        onClose = () => {},
        children,
    }: {
        show?: boolean;
        title?: string;
        onClose?: () => void;
        children: Snippet;
    } = $props();
</script>

<CommandOnly onUnavailable={() => {
    if (show) onClose();
}}>
    <Modal {show} {title} {onClose}>
        {@render children()}
    </Modal>
</CommandOnly>
