import type { ClientReadableStream } from '@grpc/grpc-js';
import { ResultAsync } from 'neverthrow';
import {
	AgentPhase,
	type AgentStatus,
	type WatchAgentStatusResponse
} from '$lib/server/agent-gateway/gateway';
import type { AppLogger } from '$lib/server/logger';
import type { AgentStatusChunk, AgentStatusTone, AgentStatusView } from '$lib/agent-status';
import { getAgentGatewayClient } from './client';

function statusLabel(phase: AgentPhase): string {
	switch (phase) {
		case AgentPhase.AGENT_PHASE_READY:
			return 'Ready';
		case AgentPhase.AGENT_PHASE_PROGRESSING:
			return 'Starting';
		case AgentPhase.AGENT_PHASE_DEGRADED:
			return 'Degraded';
		case AgentPhase.AGENT_PHASE_NOT_FOUND:
			return 'Missing';
		case AgentPhase.UNRECOGNIZED:
			return 'Unknown';
		case AgentPhase.AGENT_PHASE_UNSPECIFIED:
		default:
			return 'Pending';
	}
}

function statusTone(phase: AgentPhase): AgentStatusTone {
	switch (phase) {
		case AgentPhase.AGENT_PHASE_READY:
			return 'green';
		case AgentPhase.AGENT_PHASE_DEGRADED:
		case AgentPhase.AGENT_PHASE_NOT_FOUND:
		case AgentPhase.UNRECOGNIZED:
			return 'red';
		case AgentPhase.AGENT_PHASE_PROGRESSING:
		case AgentPhase.AGENT_PHASE_UNSPECIFIED:
		default:
			return 'yellow';
	}
}

function toAgentStatusView(status: AgentStatus): AgentStatusView {
	return {
		sessionId: status.sessionId,
		agentName: status.agentName,
		label: statusLabel(status.phase),
		tone: statusTone(status.phase)
	};
}

/**
 * Converts a gateway watch response into the browser stream shape.
 */
export function toAgentStatusChunk(res: WatchAgentStatusResponse): AgentStatusChunk {
	return {
		statuses: res.statuses.map(toAgentStatusView)
	};
}

/**
 * Starts a gateway status watch stream for the provided session IDs.
 */
export function watchAgentStatus(
	sessionIds: string[],
	logger?: AppLogger
): ResultAsync<ClientReadableStream<WatchAgentStatusResponse>, Error> {
	return ResultAsync.fromPromise(
		Promise.resolve().then(() =>
			getAgentGatewayClient().watchAgentStatus({
				sessionIds
			})
		),
		(err) =>
			err instanceof Error
				? err
				: new Error('Unable to watch agent status', {
						cause: err
					})
	).mapErr((err) => {
		logger?.withError(err).error('failed to start agent status stream');
		return err;
	});
}

/**
 * Returns an unavailable status for a session when streaming fails.
 */
export function unavailableAgentStatus(sessionId: string): AgentStatusView {
	return {
		sessionId,
		agentName: '',
		label: statusLabel(AgentPhase.UNRECOGNIZED),
		tone: statusTone(AgentPhase.UNRECOGNIZED)
	};
}
