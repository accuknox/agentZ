<script lang="ts">
	import { Button, type ButtonProps } from '$lib/components/ui/button';
	import HoverCardTrigger from '$lib/components/ui/hover-card/hover-card-trigger.svelte';
	import ContextIcon from './ContextIcon.svelte';
	import { getContextValue } from './context-context.svelte';

	type Props = ButtonProps & {
		children?: import('svelte').Snippet;
	};

	let { children, variant = 'ghost', ...props }: Props = $props();

	const context = getContextValue();
</script>

<HoverCardTrigger>
	{#if children}
		{@render children()}
	{:else}
		<Button type="button" {variant} {...props}>
			<span class="font-medium text-muted-foreground">
				{context.displayPercent}
			</span>
			<ContextIcon />
		</Button>
	{/if}
</HoverCardTrigger>
