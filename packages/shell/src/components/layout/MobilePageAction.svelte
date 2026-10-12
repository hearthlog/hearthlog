<script lang="ts">
	import type { Snippet } from 'svelte';
	import CommandOnly from '@hearthlog/ui/components/commands/CommandOnly.svelte';

	let {
		children,
		hideWhenModalOpen = false,
		isModalOpen = false,
		hidden = false
	}: {
		children: Snippet;
		/** Set while a drawer/scanner/dialog from this page is open. */
		hideWhenModalOpen?: boolean;
		isModalOpen?: boolean;
		/** Set while another surface (for example a selection bar) owns the mobile action area. */
		hidden?: boolean;
	} = $props();

	const isHidden = $derived(hidden || (hideWhenModalOpen && isModalOpen));

	// Any scroll (the page or its list) shrinks a pill with a `.stor-action-label` to its icon until it rests.
	let moving = $state(false);
	$effect(() => {
		let rest: ReturnType<typeof setTimeout> | undefined;
		const onScroll = () => {
			moving = true;
			clearTimeout(rest);
			rest = setTimeout(() => (moving = false), 500);
		};
		document.addEventListener('scroll', onScroll, { capture: true, passive: true });
		return () => {
			clearTimeout(rest);
			document.removeEventListener('scroll', onScroll, { capture: true });
		};
	});
</script>

{#if !isHidden}
	<CommandOnly>
		<div class="stor-mobile-action lg:hidden" data-moving={moving ? '' : undefined}>
			{@render children()}
		</div>
	</CommandOnly>
{/if}
