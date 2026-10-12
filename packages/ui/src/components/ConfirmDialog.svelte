<script lang="ts">
	import { AlertDialog } from "bits-ui";

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
			<header class="px-5 pt-5 pb-2">
				<AlertDialog.Title level={3} class="stor-serif-title text-xl text-[var(--stor-ink)]">
					{title}
				</AlertDialog.Title>
			</header>
			<div class="space-y-4 overflow-y-auto px-5 pb-5">
				<AlertDialog.Description class="whitespace-pre-line text-sm leading-6 text-[var(--stor-muted-text)]">
					{message}
				</AlertDialog.Description>

				<div class="flex flex-wrap justify-end gap-2 pt-2">
					<AlertDialog.Cancel
						bind:ref={cancelButton}
						autofocus
						class="min-h-11 rounded-xl bg-[var(--stor-surface-muted)] px-4 text-sm font-semibold text-[var(--stor-ink)] transition-colors hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:min-h-9"
						onclick={cancel}
					>
						Cancel
					</AlertDialog.Cancel>
					{#if alternateLabel}
						<button
							type="button"
							class="min-h-11 rounded-xl bg-[var(--stor-surface-muted)] px-4 text-sm font-semibold text-[var(--stor-ink)] transition-colors hover:bg-[var(--stor-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:min-h-9"
							onclick={alternate}
						>
							{alternateLabel}
						</button>
					{/if}
					<AlertDialog.Action
						class="min-h-11 rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:min-h-9 {tone === 'danger'
							? 'bg-[var(--stor-negative)] text-[var(--stor-negative-text)] hover:brightness-90'
							: 'bg-[var(--stor-action)] text-[var(--stor-action-text)] hover:bg-[var(--stor-action-hover)]'}"
						onclick={confirm}
					>
						{confirmLabel}
					</AlertDialog.Action>
				</div>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
