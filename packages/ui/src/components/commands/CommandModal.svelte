<script lang="ts">
    import type { Snippet } from "svelte";
    import Modal from "../Modal.svelte";
    import CommandOnly from "./CommandOnly.svelte";

    let {
        show = false,
        title = "",
        onClose = () => {},
        children,
        footer,
    }: {
        show?: boolean;
        title?: string;
        onClose?: () => void;
        children: Snippet;
        footer?: Snippet;
    } = $props();
</script>

<CommandOnly onUnavailable={() => {
    if (show) onClose();
}}>
    <Modal {show} {title} {onClose} {footer}>
        {@render children()}
    </Modal>
</CommandOnly>
