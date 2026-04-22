<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import TooltipContent from '$lib/components/ui/tooltip/tooltip-content.svelte';
	import TooltipTrigger from '$lib/components/ui/tooltip/tooltip-trigger.svelte';
	import { getPromptInputContext } from './prompt-input-context.svelte.js';

	let {
		tooltip,
		children,
		child: renderChild,
		class: className,
		side = 'top',
		...restProps
	}: {
		tooltip: import('svelte').Snippet;
		children?: import('svelte').Snippet;
		child?: import('svelte').Snippet<
			[
				{
					props: Record<string, unknown>;
				}
			]
		>;
		class?: string;
		side?: 'top' | 'bottom' | 'left' | 'right';
	} & Partial<TooltipPrimitive.RootProps> = $props();

	const context = getPromptInputContext();

	function handleClick(event: MouseEvent) {
		event.stopPropagation();
	}
</script>

<TooltipPrimitive.Root {...restProps} delayDuration={0}>
	<TooltipTrigger disabled={context.disabled} onclick={handleClick}>
		{#if renderChild}
			<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
			{#snippet child({ props }: { props: Record<string, unknown> })}
				{@render renderChild({ props })}
			{/snippet}
		{:else}
			{@render children?.()}
		{/if}
	</TooltipTrigger>
	<TooltipContent {side} class={className}>
		{@render tooltip()}
	</TooltipContent>
</TooltipPrimitive.Root>
