<script lang="ts">
	import * as HoverCard from '$lib/components/ui/hover-card/index.js';
	import { ContextClass, setContextValue, type ContextSchema } from './context-context.svelte';
	type Props = ContextSchema & {
		children?: import('svelte').Snippet;
		closeDelay?: number;
		openDelay?: number;
		[key: string]: unknown;
	};

	let {
		usedTokens,
		maxTokens,
		usage,
		modelId,
		children,
		closeDelay = 0,
		openDelay = 0,
		...props
	}: Props = $props();

	const contextInstance = new ContextClass({
		usedTokens: 0,
		maxTokens: 0
	});

	// Update context when props change
	$effect(() => {
		contextInstance.usedTokens = usedTokens;
		contextInstance.maxTokens = maxTokens;
		contextInstance.usage = usage;
		contextInstance.modelId = modelId;
	});

	setContextValue(contextInstance);
</script>

<HoverCard.Root {openDelay} {closeDelay} {...props}>
	{@render children?.()}
</HoverCard.Root>
