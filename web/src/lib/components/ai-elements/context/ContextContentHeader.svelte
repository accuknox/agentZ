<script lang="ts">
	import Progress from '$lib/components/ui/progress/progress.svelte';
	import { cn } from '$lib/utils';
	import { getContextValue, PERCENT_MAX } from './context-context.svelte';
	type Props = {
		children?: import('svelte').Snippet;
		class?: string;
		[key: string]: unknown;
	};

	let { children, class: className, ...props }: Props = $props();

	const context = getContextValue();
</script>

<div class={cn('w-full space-y-2 p-3', className)} {...props}>
	{#if children}
		{@render children()}
	{:else}
		<div class="flex items-center justify-between gap-3 text-xs">
			<p>{context.displayPercent}</p>
			<p class="font-mono text-muted-foreground">
				{context.usedTokensFormatted} / {context.maxTokensFormatted}
			</p>
		</div>
		<div class="space-y-2">
			<Progress class="bg-muted" value={context.usedPercent * PERCENT_MAX} />
		</div>
	{/if}
</div>
