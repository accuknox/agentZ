<script lang="ts">
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip/index.js';
	import type { Snippet } from 'svelte';
	import type { Tooltip as TooltipPrimitive } from 'bits-ui';

	let {
		tooltip,
		side = 'top',
		class: className,
		children,
		child: renderChild,
		...restProps
	}: {
		tooltip: Snippet;
		side?: 'top' | 'bottom' | 'left' | 'right';
		class?: string;
		children?: Snippet;
		child?: Snippet<
			[
				{
					props: Record<string, unknown>;
				}
			]
		>;
	} & TooltipPrimitive.RootProps = $props();
</script>

<TooltipProvider>
	<Tooltip delayDuration={60} {...restProps}>
		<TooltipTrigger>
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
	</Tooltip>
</TooltipProvider>
