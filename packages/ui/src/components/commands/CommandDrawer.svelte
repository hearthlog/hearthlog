<script lang="ts">
    import type { Snippet } from "svelte";
    import Drawer from "../Drawer.svelte";
    import CommandOnly from "./CommandOnly.svelte";

    let {
        show = false,
        title = "",
        description = "",
        size = "md",
        onClose = () => {},
        children,
        footer,
    }: {
        show?: boolean;
        title?: string;
        description?: string;
        size?: "md" | "lg";
        onClose?: () => void;
        children: Snippet;
        footer?: Snippet;
    } = $props();
</script>

<CommandOnly onUnavailable={() => {
    if (show) onClose();
}}>
    <Drawer {show} {title} {description} {size} {onClose} {footer}>
        {@render children()}
    </Drawer>
</CommandOnly>
