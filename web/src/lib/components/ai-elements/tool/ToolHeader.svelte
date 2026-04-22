<script lang="ts">
	import { CollapsibleTrigger } from '$lib/components/ui/collapsible/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { cn } from '$lib/utils';

	import CheckCircleIcon from '@lucide/svelte/icons/check-circle';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import XCircleIcon from '@lucide/svelte/icons/x-circle';

	type ToolUIPartType = string;
	type ToolUIPartState =
		| 'running'
		| 'completed'
		| 'error'
		| 'input-streaming'
		| 'input-available'
		| 'output-available'
		| 'output-error';

	type ToolHeaderProps = {
		type: ToolUIPartType;
		title?: string;
		state: ToolUIPartState;
		class?: string;
		[key: string]: unknown;
	};

	const statusLabels = {
		running: 'Running',
		completed: 'Completed',
		error: 'Error',
		'input-streaming': 'Pending',
		'input-available': 'Running',
		'output-available': 'Completed',
		'output-error': 'Error'
	} as const;

	const statusIcons = {
		running: ClockIcon,
		completed: CheckCircleIcon,
		error: XCircleIcon,
		'input-streaming': CircleIcon,
		'input-available': ClockIcon,
		'output-available': CheckCircleIcon,
		'output-error': XCircleIcon
	} as const;

	let { type, title, state, class: className = '', ...restProps }: ToolHeaderProps = $props();

	const statusBadge = $derived({
		IconComponent: statusIcons[state],
		label: statusLabels[state]
	});

	let id = $props.id();
</script>

<CollapsibleTrigger {id} class={cn('flex w-full items-center gap-3 p-3', className)} {...restProps}>
	<div class="flex min-w-0 flex-1 items-center gap-2">
		<WrenchIcon class="size-4 text-muted-foreground" />
		<span class="truncate text-sm font-medium">{title ?? type}</span>
	</div>
	<ChevronDownIcon
		class="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
	/>
	<Badge class="ml-auto shrink-0 gap-1.5 rounded-full text-xs" variant="secondary">
		<statusBadge.IconComponent
			class={cn(
				'size-4',
				(state === 'running' || state === 'input-available') && 'animate-pulse',
				(state === 'completed' || state === 'output-available') && 'text-green-600',
				(state === 'error' || state === 'output-error') && 'text-red-600'
			)}
		/>

		{statusBadge.label}
	</Badge>
</CollapsibleTrigger>
