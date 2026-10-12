<script lang="ts">
    import ConfirmDialog from "../ConfirmDialog.svelte";
    import CommandOnly from "./CommandOnly.svelte";

    let {
        show = false,
        title = "Confirm Action",
        message = "Are you sure you want to proceed?",
        confirmLabel = "Confirm",
        alternateLabel = "",
        tone = "danger",
        onConfirm = () => {},
        onAlternate = () => {},
        onCancel = () => {},
    }: {
        show?: boolean;
        title?: string;
        message?: string;
        confirmLabel?: string;
        alternateLabel?: string;
        tone?: "danger" | "primary";
        onConfirm?: () => unknown;
        onAlternate?: () => unknown;
        onCancel?: () => unknown;
    } = $props();
</script>

<CommandOnly onUnavailable={() => {
    if (show) void onCancel();
}}>
    <ConfirmDialog {show} {title} {message} {confirmLabel} {alternateLabel} {tone} {onConfirm} {onAlternate} {onCancel} />
</CommandOnly>
