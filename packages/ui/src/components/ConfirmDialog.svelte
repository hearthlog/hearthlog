<script lang="ts">
	import { AlertDialog } from "bits-ui";
	import { cn } from "../utils/cn.js";
	import { buttonVariants, filledDestructive } from "./ui/button-variants.js";
	import { primaryShortcut } from "./overlay-keys.js";

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
		/** Optional middle action, e.g. "Create anyway" beside "Use existing". */
		alternateLabel?: string;
		tone?: "danger" | "primary";
		onConfirm?: () => unknown;
		onAlternate?: () => unknown;
		onCancel?: () => unknown;
	} = $props();

	let closingFromAction = false;
	let cancelButton: HTMLButtonElement | null = $state(null);

	function focusCancel(event: Event) {
		event.preventDefault();
		requestAnimationFrame(() => cancelButton?.focus());
	}

	function handleOpenChange(open: boolean) {
		if (open || !show) return;
		if (closingFromAction) {
			closingFromAction = false;
			return;
		}
		void onCancel();
	}

	function cancel() {
		closingFromAction = true;
		void onCancel();
	}

	function confirm() {
		closingFromAction = true;
		void onConfirm();
	}

	function alternate() {
		closingFromAction = true;
		void onAlternate();
	}
</script>

<AlertDialog.Root open={show} onOpenChange={handleOpenChange}>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="fixed inset-0 z-[var(--stor-layer-dialog)] bg-[var(--stor-overlay)]" />
		<AlertDialog.Content onOpenAutoFocus={focusCancel} class="stor-sheet fixed inset-x-4 bottom-4 z-[var(--stor-layer-dialog-content)] flex max-h-[calc(100dvh-2rem-env(safe-area-inset-top))] flex-col overflow-hidden rounded-[var(--stor-panel-radius)] outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2">
			<header class="shrink-0 px-5 pb-2 pt-5 sm:px-6 sm:pt-6">
				<AlertDialog.Title level={3} class="stor-title-2 text-[var(--stor-ink)]">
					{title}
				</AlertDialog.Title>
			</header>
			<div class="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6">
				<AlertDialog.Description class="whitespace-pre-line text-body text-[var(--stor-muted-text)]">
					{message}
				</AlertDialog.Description>
			</div>
			<!-- Primary on the right, and the one place a destructive action keeps its red fill. ⌘↵ confirms. -->
			<footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-5 sm:px-6 sm:pb-6" {@attach primaryShortcut}>
				<AlertDialog.Cancel
					bind:ref={cancelButton}
					autofocus
					class={buttonVariants({ variant: "secondary" })}
					onclick={cancel}
				>
					Cancel
				</AlertDialog.Cancel>
				{#if alternateLabel}
					<button
						type="button"
						class={buttonVariants({ variant: "secondary" })}
						onclick={alternate}
					>
						{alternateLabel}
					</button>
				{/if}
				<AlertDialog.Action
					data-stor-primary
					class={cn(buttonVariants({ variant: "default" }), tone === "danger" && filledDestructive)}
					onclick={confirm}
				>
					{confirmLabel}
				</AlertDialog.Action>
			</footer>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
