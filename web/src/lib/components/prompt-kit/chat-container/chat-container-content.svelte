<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		children,
		class: className,
		...restProps
	}: {
		children?: import('svelte').Snippet;
		class?: string;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn('flex w-full flex-col', className)} {...restProps}>
	{@render children?.()}
</div>
