<script lang="ts">
	import { cn } from '$lib/utils';
	import * as Code from '$lib/components/ai-elements/code/index.js';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { SupportedLanguage } from '../code/shiki';

	type ToolOutputValue = Record<string, unknown> | string | number | boolean | null;

	type ToolOutputProps = HTMLAttributes<HTMLDivElement> & {
		class?: string;
		output?: ToolOutputValue;
		errorText?: string;
		children?: Snippet;
	};

	let { class: className = '', output, errorText, ...restProps }: ToolOutputProps = $props();

	let shouldRender = $derived.by(() => {
		return !!(output || errorText);
	});
	type OutputComp = {
		type: 'code' | 'text';
		content: string;
		language: SupportedLanguage;
	};

	let outputComponent: OutputComp | null = $derived.by(() => {
		if (!output) return null;

		if (typeof output === 'object') {
			return {
				type: 'code',
				content: JSON.stringify(output, null, 2),
				language: 'json'
			};
		} else if (typeof output === 'string') {
			return {
				type: 'code',
				content: output,
				language: 'json'
			};
		} else {
			return {
				type: 'text',
				content: String(output),
				language: 'text'
			};
		}
	});

	let id = $props.id();
</script>

{#if shouldRender}
	<div {id} class={cn('space-y-2 p-4', className)} {...restProps}>
		<h4 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
			{errorText ? 'Error' : 'Result'}
		</h4>
		<div
			class={cn(
				'overflow-x-auto rounded-md text-xs [&_table]:w-full',
				errorText ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground'
			)}
		>
			{#if errorText}
				<div class="p-3">{errorText}</div>
			{:else if outputComponent}
				{#if outputComponent.type === 'code'}
					<Code.Root code={outputComponent.content} lang={outputComponent.language} hideLines>
						<Code.CopyButton />
					</Code.Root>
				{:else}
					<div class="p-3">{outputComponent.content}</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
