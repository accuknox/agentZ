export type AgentStatusTone = 'green' | 'yellow' | 'red';

export interface AgentStatusView {
	sessionId: string;
	agentName: string;
	label: string;
	tone: AgentStatusTone;
}

export interface AgentStatusChunk {
	statuses: AgentStatusView[];
}

const tones = new Set<AgentStatusTone>(['green', 'yellow', 'red']);

function isAgentStatusView(value: unknown): value is AgentStatusView {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const item = value as Record<string, unknown>;

	return (
		typeof item.sessionId === 'string' &&
		typeof item.agentName === 'string' &&
		typeof item.label === 'string' &&
		typeof item.tone === 'string' &&
		tones.has(item.tone as AgentStatusTone)
	);
}

export function isAgentStatusChunk(value: unknown): value is AgentStatusChunk {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const chunk = value as Record<string, unknown>;

	return Array.isArray(chunk.statuses) && chunk.statuses.every(isAgentStatusView);
}
