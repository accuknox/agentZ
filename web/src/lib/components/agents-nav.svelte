<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import type { AgentStatusView } from '$lib/agent-status';
	import { AgentStatusStream } from '$lib/agent-status-stream.svelte';
	import type { SessionSummary } from '$lib/session';
	import { cn } from '$lib/utils';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import BotIcon from '@lucide/svelte/icons/bot';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let { sessions }: { sessions: SessionSummary[] } = $props();
	let open = $state(page.url.pathname.startsWith('/agents'));
	let statuses = $state<Record<string, AgentStatusView>>({});
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let streamId = 0;

	const sessionIds = $derived(sessions.map(({ sessionId }) => sessionId));
	const statusStream = new AgentStatusStream({
		onChunk: (chunk) => {
			const next = { ...statuses };

			for (const status of chunk.statuses) {
				next[status.sessionId] = status;
			}

			statuses = next;
		}
	});

	function getPillClass(tone: AgentStatusView['tone']): string {
		switch (tone) {
			case 'green':
				return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
			case 'yellow':
				return 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300';
			case 'red':
				return 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300';
		}
	}

	function clearRetryTimer() {
		if (!retryTimer) {
			return;
		}

		clearTimeout(retryTimer);
		retryTimer = null;
	}

	function markUnknown() {
		const next = { ...statuses };

		for (const session of sessions) {
			next[session.sessionId] = {
				sessionId: session.sessionId,
				agentName: session.agentName,
				label: 'Unknown',
				tone: 'red'
			};
		}

		statuses = next;
	}

	function startStream(ids: string[], isOpen: boolean) {
		clearRetryTimer();
		streamId += 1;
		const currentStreamId = streamId;
		const trackedIds = [...ids];

		statusStream.abort();
		if (!isOpen || trackedIds.length === 0) {
			return;
		}

		void (async () => {
			const result = await statusStream.start(trackedIds);

			if (currentStreamId !== streamId) {
				return;
			}

			if (result.isErr() && result.error.name !== 'AbortError') {
				markUnknown();
				retryTimer = setTimeout(() => startStream(trackedIds, isOpen), 1500);
			}
		})();
	}

	$effect(() => {
		startStream(sessionIds, open);
	});

	onDestroy(() => {
		clearRetryTimer();
		statusStream.abort();
	});
</script>

<Sidebar.Group>
	<Sidebar.Menu>
		<Collapsible.Root bind:open class="group/collapsible">
			{#snippet child({ props })}
				<Sidebar.MenuItem {...props}>
					<Collapsible.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton {...props} tooltipContent="Agents" class="cursor-pointer">
								<BotIcon />
								<span>Agents</span>
								<ChevronRightIcon
									class="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
								/>
							</Sidebar.MenuButton>
						{/snippet}
					</Collapsible.Trigger>
					<Collapsible.Content>
						<Sidebar.MenuSub>
							{#if sessions.length === 0}
								<Sidebar.MenuSubItem>
									<div
										class="h-7 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
									>
										No agents
									</div>
								</Sidebar.MenuSubItem>
							{:else}
								{#each sessions as session (session.sessionId)}
									{@const status = statuses[session.sessionId]}
									{@const label = status?.label ?? 'Pending'}
									{@const tone = status?.tone ?? 'yellow'}
									<Sidebar.MenuSubItem>
										<Sidebar.MenuSubButton class="cursor-default">
											<span class="min-w-0 flex-1 truncate">{session.agentName}</span>
											<span
												class={cn(
													'ms-auto inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[0.65rem] leading-none font-medium',
													getPillClass(tone)
												)}
											>
												{label}
											</span>
										</Sidebar.MenuSubButton>
									</Sidebar.MenuSubItem>
								{/each}
							{/if}
						</Sidebar.MenuSub>
					</Collapsible.Content>
				</Sidebar.MenuItem>
			{/snippet}
		</Collapsible.Root>
	</Sidebar.Menu>
</Sidebar.Group>
