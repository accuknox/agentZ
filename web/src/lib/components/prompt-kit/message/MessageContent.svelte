<script lang="ts">
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import Markdown from '$lib/components/prompt-kit/markdown/Markdown.svelte';

	let {
		markdown = false,
		class: className,
		content,
		children,
		...restProps
	}: {
		content?: string;
		markdown?: boolean;
		class?: string;
		children?: Snippet;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

{#if markdown && content}
	<div
		class={cn('max-w-none break-words whitespace-normal text-foreground', className)}
		{...restProps}
	>
		<Markdown {content}></Markdown>
	</div>
{:else}
	<div
		class={cn(
			'rounded-lg bg-secondary p-2 break-words whitespace-normal text-foreground',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</div>
{/if}
