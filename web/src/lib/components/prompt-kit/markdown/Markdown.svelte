<script lang="ts">
	import { cn } from '$lib/utils';
	import { Streamdown, type StreamdownProps } from 'svelte-streamdown';
	import { mode } from 'mode-watcher';
	import type { HTMLAttributes } from 'svelte/elements';
	import githubLightDefault from '@shikijs/themes/github-light-default';
	import githubDarkDefault from '@shikijs/themes/github-dark-default';
	import Code from 'svelte-streamdown/code';

	type Props = {
		content: string;
		id?: string;
		class?: string;
	} & Omit<StreamdownProps, 'content' | 'class'> &
		Omit<HTMLAttributes<HTMLDivElement>, 'content'>;

	let { content, id, class: className, ...restProps }: Props = $props();
	let currentTheme = $derived(
		mode.current === 'dark' ? 'github-dark-default' : 'github-light-default'
	);

	const markdownClasses = cn(
		'markdown-renderer max-w-none text-[0.98rem] leading-7 text-foreground',
		'[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
		'[&_h1]:mt-6 [&_h1]:mb-2.5 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight',
		'[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight',
		'[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-semibold',
		'[&_p]:my-2.5 [&_p]:text-foreground',
		'[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:ps-6',
		'[&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:ps-6',
		'[&_li]:my-1 [&_li>p]:my-1',
		'[&_blockquote]:my-3.5 [&_blockquote]:rounded-r-xl [&_blockquote]:border-l-3 [&_blockquote]:border-border [&_blockquote]:bg-muted/35 [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:italic',
		'[&_hr]:my-4 [&_hr]:border-border',
		'[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
		'[&_table]:w-full [&_table]:border-separate [&_table]:border-spacing-0',
		'[&_thead]:bg-muted/45 [&_th]:border-b [&_th]:border-border/80 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-sm [&_th]:font-semibold',
		'[&_td]:border-t [&_td]:border-border/60 [&_td]:px-4 [&_td]:py-2.5 [&_td]:align-top',
		'[&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-muted/70 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.92em]',
		'[&_pre]:overflow-x-auto [&_pre]:py-4',
		'[&_pre]:[-ms-overflow-style:none] [&_pre]:[scrollbar-width:thin]',
		'[&_pre_code]:block [&_pre_code]:min-w-max [&_pre_code]:whitespace-pre [&_pre_code]:px-4 [&_pre_code]:font-mono [&_pre_code]:text-[0.92rem] [&_pre_code]:leading-6 [&_pre_code]:[overflow-wrap:normal] [&_pre_code]:[word-break:normal]',
		'[&_pre_code>span]:whitespace-pre',
		'[&_figure[data-rehype-pretty-code-figure]]:my-4 [&_figure[data-rehype-pretty-code-figure]]:overflow-hidden [&_figure[data-rehype-pretty-code-figure]]:rounded-2xl [&_figure[data-rehype-pretty-code-figure]]:border [&_figure[data-rehype-pretty-code-figure]]:border-border/70 [&_figure[data-rehype-pretty-code-figure]]:bg-muted/35 [&_figure[data-rehype-pretty-code-figure]]:shadow-sm',
		'[&_figure[data-rehype-pretty-code-figure]_pre]:my-0 [&_figure[data-rehype-pretty-code-figure]_pre]:rounded-none [&_figure[data-rehype-pretty-code-figure]_pre]:border-0 [&_figure[data-rehype-pretty-code-figure]_pre]:bg-transparent [&_figure[data-rehype-pretty-code-figure]_pre]:py-4',
		'[&_figcaption]:border-b [&_figcaption]:border-border/60 [&_figcaption]:bg-background/70 [&_figcaption]:px-4 [&_figcaption]:py-2 [&_figcaption]:font-mono [&_figcaption]:text-xs [&_figcaption]:uppercase [&_figcaption]:tracking-[0.16em] [&_figcaption]:text-muted-foreground'
	);
</script>

<div {id} class={cn(className)} {...restProps}>
	<Streamdown
		{content}
		class={markdownClasses}
		shikiTheme={currentTheme}
		baseTheme="shadcn"
		components={{ code: Code }}
		shikiThemes={{
			'github-light-default': githubLightDefault,
			'github-dark-default': githubDarkDefault
		}}
	/>
</div>

<style>
	:global(.markdown-renderer [data-streamdown-code]) {
		margin: 1rem 0;
		border: 1px solid color-mix(in oklab, var(--color-border) 72%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in oklab, var(--color-muted) 35%, transparent);
	}

	:global(.markdown-renderer [data-streamdown-code] > pre) {
		margin: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
	}

	:global(.markdown-renderer [data-streamdown-table]) {
		margin: 1rem 0;
		border: 1px solid color-mix(in oklab, var(--color-border) 72%, transparent);
		border-radius: var(--radius-sm);
	}

	:global(.markdown-renderer [data-streamdown-table] > table) {
		margin: 0;
		border: 0;
		border-radius: 0;
	}

	:global(.markdown-renderer [data-streamdown-table-download]) {
		display: none;
	}
</style>
