<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className,
		...restProps
	}: {
		class?: string;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
	class={cn('h-px w-full shrink-0 scroll-mt-4', className)}
	aria-hidden="true"
	{...restProps}
></div>
