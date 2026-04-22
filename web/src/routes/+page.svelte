<script lang="ts">
	import {
		ChatContainerContent,
		ChatContainerRoot
	} from '$lib/components/prompt-kit/chat-container';
	import * as Context from '$lib/components/ai-elements/context/index.js';
	import {
		Reasoning,
		ReasoningTrigger,
		ReasoningContent
	} from '$lib/components/ai-elements/reasoning/index.js';
	import {
		Checkpoint,
		CheckpointIcon,
		CheckpointTrigger
	} from '$lib/components/ai-elements/checkpoint/index.js';
	import {
		Tool,
		ToolHeader,
		ToolContent,
		ToolInput,
		ToolOutput
	} from '$lib/components/ai-elements/tool/index.js';
	import {
		Message,
		MessageContent,
		MessageActions,
		MessageAction
	} from '$lib/components/prompt-kit/message';
	import { Loader } from '$lib/components/prompt-kit/loader';
	import { ThinkingBar } from '$lib/components/prompt-kit/thinking-bar/index.js';
	import {
		FileUpload,
		FileUploadContent,
		FileUploadTrigger
	} from '$lib/components/prompt-kit/file-upload';
	import {
		PromptInput,
		PromptInputAction,
		PromptInputActions,
		PromptInputTextarea
	} from '$lib/components/prompt-kit/prompt-input';
	import { ScrollButton, setScrollContext } from '$lib/components/prompt-kit/scroll-button';
	import { Button } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import XIcon from '@lucide/svelte/icons/x';
	import { marked } from 'marked';
	import { watch } from 'runed';
	import DOMPurify from 'isomorphic-dompurify';

	const scrollContext = setScrollContext();
	const contextUsage = {
		inputTokens: 32_000,
		outputTokens: 8000,
		cachedInputTokens: 0,
		reasoningTokens: 0
	};

	type ChatMessage = {
		id: number;
		role: 'user' | 'assistant';
		content: string;
	};

	type PendingPhase = 'idle' | 'thinking' | 'reasoning';
	type MockToolState = 'running' | 'completed' | 'error';
	type HostExecTool = {
		name: 'host_exec';
		state: MockToolState;
		input: { command: string };
		output?: { stdout: string };
		errorText?: string;
	};
	type WebFetchTool = {
		name: 'web_fetch';
		state: MockToolState;
		input: { url: string; method: string };
		output?: { status: number; title: string; excerpt: string };
		errorText?: string;
	};
	type GenericTool = {
		name: string;
		state: MockToolState;
		input: Record<string, unknown>;
		output?: Record<string, unknown>;
		errorText?: string;
	};
	type MockTool = HostExecTool | WebFetchTool | GenericTool;

	let messages = $state<ChatMessage[]>([
		{
			id: 1,
			role: 'user',
			content: 'Hello! Can you help me with a coding question?'
		},
		{
			id: 2,
			role: 'assistant',
			content:
				"Of course! I'd be happy to help with your coding question. What would you like to know?"
		},
		{
			id: 3,
			role: 'user',
			content: 'How do I create a responsive layout with CSS Grid?'
		},
		{
			id: 4,
			role: 'assistant',
			content:
				"Creating a responsive layout with CSS Grid is straightforward. Here's a basic example:\n\n```css\n.container {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));\n  gap: 1rem;\n}\n```\n\nThis creates a grid where:\n- Columns automatically fit as many as possible\n- Each column is at least 250px wide\n- Columns expand to fill available space\n- There's a 1rem gap between items\n\nWould you like me to explain more about how this works?"
		},
		{
			id: 5,
			role: 'user',
			content: 'What is the capital of France?'
		},
		{
			id: 6,
			role: 'assistant',
			content: 'The capital of France is Paris.'
		},
		{
			id: 7,
			role: 'user',
			content: 'Can you show me a fuller markdown answer with examples?'
		},
		{
			id: 8,
			role: 'assistant',
			content:
				'# Markdown Rendering Review\n\nThis response exercises multiple markdown patterns so we can inspect readability.\n\n## Highlights\n\n- Inline code like `fetch(\'/api/threads\')` should sit cleanly in paragraphs.\n- Emphasis should be distinct: **bold**, _italic_, and ~~strikethrough~~.\n- Lists should have enough breathing room between items.\n\n> Blockquotes should feel separate from paragraph text and should not collapse into the same rhythm.\n\n### JavaScript Example\n\n```ts\nexport async function loadThreads(signal?: AbortSignal) {\n  const res = await fetch(\'/api/threads\', {\n    method: \'GET\',\n    headers: {\n      Accept: \'application/json\'\n    },\n    signal\n  });\n\n  if (!res.ok) {\n    throw new Error(`Request failed with ${res.status}`);\n  }\n\n  return (await res.json()) as Array<{ id: string; title: string }>;\n}\n```\n\n### Shell Example\n\n```bash\ncurl -X POST http://localhost:3000/api/run \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{\n    "query": "Explain CSS grid",\n    "stream": true\n  }\'\n```\n\n### Long Line Overflow\n\n```json\n{"kind":"event","id":"evt_01jv6x9n61w5q9r9v1k3t4p8ma","payload":{"message":"This line is intentionally long so we can confirm horizontal scrolling works instead of clipping or forced wrapping inside the code block container."}}\n```\n\n### Table\n\n| Element | Problem today | Desired behavior |\n| --- | --- | --- |\n| Code fences | Cramped | Clear padding and separation |\n| Long lines | Awkward wrapping | Horizontal scrolling |\n| Paragraph rhythm | Uneven | Consistent spacing |\n\n1. Ordered lists should line up correctly.\n2. Nested content should stay readable.\n3. Code blocks should preserve line breaks exactly.\n\n---\n\nFinal note: readability depends more on spacing and contrast than on decorative styling.'
		}
	]);

	let prompt = $state('');
	let isLoading = $state(false);
	let files = $state<File[]>([]);
	let containerRef = $state<HTMLDivElement | null>(null);
	let pendingPhase = $state<PendingPhase>('idle');
	let isReasoningStreaming = $state(false);
	let reasoningText = $state('');
	let reasoningTokenIndex = $state(0);
	let reasoningTokens = $state<string[]>([]);
	const checkpointsByMessageId: Record<number, string[]> = {
		6: ['Context compacted'],
		8: ['Worked for 15m30s']
	};
	const toolsByMessageId: Record<number, MockTool[]> = {
		4: [
			{
				name: 'web_fetch',
				state: 'completed',
				input: {
					url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout',
					method: 'GET'
				},
				output: {
					status: 200,
					title: 'CSS grid layout - CSS | MDN',
					excerpt: 'CSS Grid Layout excels at dividing a page into major regions.'
				}
			}
		],
		6: [
			{
				name: 'host_exec',
				state: 'running',
				input: {
					command: 'go test ./... -run TestGridLayoutRendering -count=1'
				},
				output: {
					stdout: '=== RUN   TestGridLayoutRendering\n--- PASS: TestGridLayoutRendering (0.42s)'
				}
			}
		],
		8: [
			{
				name: 'lint_markdown',
				state: 'error',
				input: {
					path: '/docs/rendering-review.md',
					ruleSet: 'default'
				},
				errorText: 'lint_markdown: frontmatter block missing required title field'
			}
		]
	};

	const reasoningSteps = [
		'Let me think about this request step by step.',
		'\n\nFirst, I need to understand what the user is asking for.',
		'\n\nThey want the reasoning stage to appear only after the initial thinking placeholder.',
		'\n\nThen, once the response is ready, the reasoning panel should collapse naturally instead of disappearing.'
	].join('');

	watch(
		() => containerRef,
		() => {
			if (containerRef) {
				scrollContext.setElement(containerRef);
			}
		}
	);

	function handleFilesAdded(newFiles: File[]) {
		files = [...files, ...newFiles];
	}

	function removeFile(index: number) {
		files = files.filter((_, i) => i !== index);
	}

	function chunkIntoTokens(text: string): string[] {
		let tokenList: string[] = [];
		let i = 0;

		while (i < text.length) {
			let chunkSize = Math.floor(Math.random() * 2) + 3;
			tokenList.push(text.slice(i, i + chunkSize));
			i += chunkSize;
		}

		return tokenList;
	}

	function truncateEnd(value: string, maxLength: number): string {
		if (value.length <= maxLength) return value;

		return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
	}

	function isHostExecTool(tool: MockTool): tool is HostExecTool {
		return tool.name === 'host_exec';
	}

	function isWebFetchTool(tool: MockTool): tool is WebFetchTool {
		return tool.name === 'web_fetch';
	}

	function getToolTitle(tool: MockTool): string {
		if (isHostExecTool(tool)) {
			return `Ran ${truncateEnd(tool.input.command, 36)}`;
		}

		if (isWebFetchTool(tool)) {
			return `Searching ${truncateEnd(tool.input.url, 44)}`;
		}

		return tool.name;
	}

	watch(
		[() => isReasoningStreaming, () => reasoningTokenIndex],
		([isStreamingValue, tokenIndex]) => {
			if (!isStreamingValue) return;

			if (tokenIndex >= reasoningTokens.length) {
				isReasoningStreaming = false;
				return;
			}

			const timer = setTimeout(() => {
				reasoningText = reasoningText + reasoningTokens[tokenIndex];
				reasoningTokenIndex = tokenIndex + 1;
			}, 25);

			return () => clearTimeout(timer);
		}
	);

	function handleSubmit() {
		if (!prompt.trim() && files.length === 0) return;

		const names = files.map((file) => file.name);
		const content = prompt.trim()
			? prompt
			: `Attached ${names.length} file${names.length === 1 ? '' : 's'}.`;
		const fileNote = names.length > 0 ? `\n\nFiles: ${names.join(', ')}` : '';

		messages = [
			...messages,
			{
				id: messages.length + 1,
				role: 'user',
				content: `${content}${fileNote}`
			}
		];

		const userPrompt = prompt;
		const uploadedFiles = names;
		prompt = '';
		files = [];
		isLoading = true;
		pendingPhase = 'thinking';
		isReasoningStreaming = false;
		reasoningText = '';
		reasoningTokenIndex = 0;
		reasoningTokens = chunkIntoTokens(reasoningSteps);

		setTimeout(() => {
			pendingPhase = 'reasoning';
			isReasoningStreaming = true;
		}, 450);

		setTimeout(() => {
			const uploadNote =
				uploadedFiles.length > 0
					? ` I also received ${uploadedFiles.length} attached file${
							uploadedFiles.length === 1 ? '' : 's'
						}: ${uploadedFiles.join(', ')}.`
					: '';
			messages = [
				...messages,
				{
					id: messages.length + 1,
					role: 'assistant',
					content:
						`You asked: "${userPrompt || 'your file upload'}".` +
						`${uploadNote} This is a simulated response.`
				}
			];
			isReasoningStreaming = false;
			pendingPhase = 'idle';
			isLoading = false;
		}, 1500);
	}
	function handleCopy(content: string) {
		navigator.clipboard.writeText(content);
	}
</script>

<main class="flex min-h-0 w-full flex-1 flex-col bg-background">
	<div class="relative min-h-0 flex-1 overflow-hidden">
		<div bind:this={containerRef} class="h-full overflow-y-auto pb-5">
			<ChatContainerRoot
				class="relative h-full w-full flex-1 space-y-0 overflow-y-auto px-3 md:px-4"
			>
				<ChatContainerContent class="min-w-full space-y-8 px-2 py-4">
					{#each messages as message, index (message.id)}
						{@const isAssistant = message.role === 'assistant'}
						{@const isLastMessage = index === messages.length - 1}
						{@const messageCheckpoints = checkpointsByMessageId[message.id] ?? []}
						{@const messageTools = toolsByMessageId[message.id] ?? []}
						<Message
							class={cn(
								'mx-auto flex w-full max-w-5xl flex-col gap-2 px-0 md:px-4',
								isAssistant ? 'items-start' : 'items-end'
							)}
						>
							{#if isAssistant}
								<div class="group flex w-full flex-col gap-0">
									{#if pendingPhase === 'reasoning' && !isLoading && isLastMessage}
										<Reasoning class="mb-1 w-full" isStreaming={isReasoningStreaming}>
											<ReasoningTrigger class="text-base" />
											<ReasoningContent class="mt-1 text-base">
												<!-- The markdown HTML is sanitized before rendering. -->
												<!-- eslint-disable-next-line svelte/no-at-html-tags -->
												{@html DOMPurify.sanitize(marked(reasoningText, { async: false }))}
											</ReasoningContent>
										</Reasoning>
									{/if}
									{#if messageCheckpoints.length > 0}
										<div class="mb-2 flex flex-col gap-1">
											{#each messageCheckpoints as checkpoint (checkpoint)}
												<Checkpoint class="w-full text-sm">
													<CheckpointIcon />
													<CheckpointTrigger
														variant="ghost"
														size="sm"
														class="h-auto shrink-0 px-1.5 py-1 font-normal"
													>
														{checkpoint}
													</CheckpointTrigger>
												</Checkpoint>
											{/each}
										</div>
									{/if}
									{#if messageTools.length > 0}
										<div class="mb-3 flex flex-col gap-2">
											{#each messageTools as tool (`${message.id}-${tool.name}`)}
												<Tool class="mb-0 w-full">
													<ToolHeader
														type={tool.name}
														title={getToolTitle(tool)}
														state={tool.state}
													/>
													<ToolContent>
														<ToolInput input={tool.input} />
														<ToolOutput output={tool.output} errorText={tool.errorText} />
													</ToolContent>
												</Tool>
											{/each}
										</div>
									{/if}
									<MessageContent
										class="prose w-full flex-1 rounded-lg bg-transparent p-0 text-foreground"
										markdown={true}
										content={message.content}
									></MessageContent>
									<MessageActions
										class={cn(
											'-ml-2.5 flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100',
											isLastMessage && 'opacity-100'
										)}
									>
										<MessageAction>
											{#snippet tooltip()}
												<p>Copy</p>
											{/snippet}
											{#snippet child({ props })}
												<Button
													variant="ghost"
													size="icon"
													class="h-8 w-8"
													onclick={() => handleCopy(message.content)}
													{...props}
												>
													<CopyIcon class="h-4 w-4" />
												</Button>
											{/snippet}
										</MessageAction>
									</MessageActions>
								</div>
							{:else}
								<div class="group flex w-full flex-col items-end gap-1">
									<MessageContent
										class="max-w-[85%] rounded-3xl bg-muted px-5 py-2.5 text-primary sm:max-w-[75%]"
									>
										{message.content}
									</MessageContent>
									<MessageActions
										class={cn(
											'flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100'
										)}
									>
										<MessageAction>
											{#snippet tooltip()}
												<p>Copy</p>
											{/snippet}
											{#snippet child({ props })}
												<Button
													variant="ghost"
													size="icon"
													class="h-8 w-8"
													onclick={() => handleCopy(message.content)}
													{...props}
												>
													<CopyIcon class="h-4 w-4" />
												</Button>
											{/snippet}
										</MessageAction>
									</MessageActions>
								</div>
							{/if}
						</Message>
					{/each}
					{#if isLoading && pendingPhase !== 'idle'}
						<div class="mx-auto w-full max-w-5xl px-0 md:px-4">
							<div class="rounded-lg bg-transparent py-0">
								{#if pendingPhase === 'reasoning'}
									<Reasoning class="mb-1 w-full" isStreaming={isReasoningStreaming}>
										<ReasoningTrigger class="text-base" />
										<ReasoningContent class="mt-1 text-base">
											<!-- The markdown HTML is sanitized before rendering. -->
											<!-- eslint-disable-next-line svelte/no-at-html-tags -->
											{@html DOMPurify.sanitize(marked(reasoningText, { async: false }))}
										</ReasoningContent>
									</Reasoning>
								{:else if pendingPhase === 'thinking'}
									<ThinkingBar />
								{/if}
							</div>
						</div>
					{/if}
				</ChatContainerContent>
			</ChatContainerRoot>
		</div>
		<div class="absolute right-4 bottom-4">
			<ScrollButton class="shadow-sm" />
		</div>
	</div>

	<div class="z-10 shrink-0 bg-background px-3 pb-3 md:px-4 md:pb-4">
		<div class="mx-auto w-full max-w-5xl">
			<FileUpload onFilesAdded={handleFilesAdded} accept=".jpg,.jpeg,.png,.pdf,.doc,.docx,.txt,.md">
				<PromptInput
					{isLoading}
					value={prompt}
					onValueChange={(v) => (prompt = v)}
					onSubmit={handleSubmit}
					class="relative z-10 w-full rounded-3xl border border-input bg-popover p-0 pt-1 shadow-xs"
				>
					<div class="flex flex-col">
						{#if files.length > 0}
							<div class="flex flex-wrap gap-2 px-3 pt-2">
								{#each files as file, index (`${file.name}-${index}`)}
									<div class="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-sm">
										<PaperclipIcon class="size-4 shrink-0" />
										<span class="max-w-40 truncate">{file.name}</span>
										<button
											type="button"
											class="rounded-full p-0.5 transition-colors hover:bg-background"
											onclick={() => removeFile(index)}
											aria-label={`Remove ${file.name}`}
										>
											<XIcon class="size-3.5" />
										</button>
									</div>
								{/each}
							</div>
						{/if}

						<PromptInputTextarea
							placeholder="Ask anything or drop files here"
							class="min-h-11 pt-3 pl-4 text-base leading-[1.3] sm:text-base md:text-base"
						/>

						<PromptInputActions
							class="mt-5 flex w-full items-center justify-between gap-2 px-3 pb-3"
						>
							<div class="flex items-center gap-2">
								{#if isLoading}
									<Loader variant="wave" size="sm" />
								{:else}
									<PromptInputAction>
										{#snippet tooltip()}
											<p>Attach files</p>
										{/snippet}
										{#snippet child({ props })}
											<FileUploadTrigger asChild>
												<div
													class="flex size-9 cursor-pointer items-center justify-center rounded-full border border-input transition-colors hover:bg-accent"
													{...props}
												>
													<PaperclipIcon class="h-4.5 w-4.5" />
												</div>
											</FileUploadTrigger>
										{/snippet}
									</PromptInputAction>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								<Context.Root
									maxTokens={128_000}
									modelId="openai:gpt-5"
									usage={contextUsage}
									usedTokens={40_000}
								>
									<Context.Trigger />
									<Context.Content>
										<Context.ContentHeader />
										<Context.ContentBody>
											<Context.InputUsage />
											<Context.OutputUsage />
											<Context.ReasoningUsage />
											<Context.CacheUsage />
										</Context.ContentBody>
										<Context.ContentFooter />
									</Context.Content>
								</Context.Root>
								<Button
									size="icon"
									disabled={(!prompt.trim() && files.length === 0) || isLoading}
									onclick={handleSubmit}
									class="size-9 rounded-full"
								>
									{#if !isLoading}
										<ArrowUpIcon class="h-4.5 w-4.5" />
									{:else}
										<span class="size-3 rounded-xs bg-white"></span>
									{/if}
								</Button>
							</div>
						</PromptInputActions>
					</div>
				</PromptInput>

				<FileUploadContent>
					<div class="flex min-h-55 w-full items-center justify-center px-4">
						<div
							class="w-full max-w-md rounded-3xl border border-border bg-background/95 p-8 text-center shadow-lg"
						>
							<div
								class="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-muted"
							>
								<PaperclipIcon class="size-6" />
							</div>
							<h3 class="text-lg font-medium">Drop files to attach</h3>
							<p class="mt-2 text-sm text-muted-foreground">
								Release to add them to the message composer.
							</p>
						</div>
					</div>
				</FileUploadContent>
			</FileUpload>
		</div>
	</div>
</main>
