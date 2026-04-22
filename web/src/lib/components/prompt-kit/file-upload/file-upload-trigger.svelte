<script lang="ts">
	import { getContext } from 'svelte';
	import type { FileUploadContext } from './file-upload-context.svelte';
	import type { Snippet } from 'svelte';

	type Props = {
		asChild?: boolean;
		class?: string;
		children: Snippet;
		onclick?: (e: MouseEvent) => void;
		[key: string]: unknown;
	};

	let { asChild = false, class: className, children, onclick, ...restProps }: Props = $props();

	const context = getContext<FileUploadContext>('file-upload');

	function handleClick(e: MouseEvent) {
		e.stopPropagation();
		context?.inputRef?.click();
		onclick?.(e);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			e.stopPropagation();
			context?.inputRef?.click();
		}
	}
</script>

{#if asChild}
	<div
		role="button"
		tabindex="0"
		class={className}
		onclick={handleClick}
		onkeydown={handleKeyDown}
		{...restProps}
	>
		{@render children()}
	</div>
{:else}
	<button type="button" class={className} onclick={handleClick} {...restProps}>
		{@render children()}
	</button>
{/if}
