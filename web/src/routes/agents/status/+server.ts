import { Result, ResultAsync, err, ok, type Result as ResultType } from 'neverthrow';
import type { RequestHandler } from './$types';
import type { AgentStatusChunk } from '$lib/agent-status';
import { toError } from '$lib/errors';
import {
	toAgentStatusChunk,
	unavailableAgentStatus,
	watchAgentStatus
} from '$lib/server/agent-gateway/status';

const encoder = new TextEncoder();

type StatusRequest = {
	sessionIds: string[];
};

function parseStatusRequest(value: unknown): ResultType<StatusRequest, Error> {
	if (!value || typeof value !== 'object') {
		return err(new Error('Expected a JSON object'));
	}

	if (!('sessionIds' in value) || !Array.isArray(value.sessionIds)) {
		return err(new Error('sessionIds must be an array'));
	}

	const sessionIds: string[] = [];

	for (const item of value.sessionIds) {
		if (typeof item !== 'string') {
			return err(new Error('sessionIds must contain strings'));
		}

		const sessionId = item.trim();
		if (!sessionId) {
			return err(new Error('sessionIds must not contain empty values'));
		}

		sessionIds.push(sessionId);
	}

	return ok({ sessionIds });
}

function badRequest(message: string): Response {
	return new Response(JSON.stringify({ message }), {
		status: 400,
		headers: {
			'Content-Type': 'application/json; charset=utf-8'
		}
	});
}

function sseFrame(chunk: AgentStatusChunk): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

export const POST: RequestHandler = async (event) => {
	const logger = event.locals.logger.child().withContext({
		routeId: '/agents/status',
		routeType: 'stream'
	});
	const body = await ResultAsync.fromPromise(event.request.json(), (cause) =>
		toError(cause, 'Unable to parse status stream request')
	);

	if (body.isErr()) {
		logger.withError(body.error).warn('agent status request body is invalid');
		return badRequest('Invalid JSON request body');
	}

	const parsed = parseStatusRequest(body.value);
	if (parsed.isErr()) {
		logger.withError(parsed.error).warn('agent status request rejected');
		return badRequest(parsed.error.message);
	}

	const { sessionIds } = parsed.value;
	if (sessionIds.length === 0) {
		return badRequest('At least one session is required');
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const watch = await watchAgentStatus(sessionIds, logger);
			if (watch.isErr()) {
				controller.enqueue(
					sseFrame({
						statuses: sessionIds.map(unavailableAgentStatus)
					})
				);
				controller.close();
				return;
			}

			const call = watch.value;
			const close = () => {
				Result.fromThrowable(
					() => controller.close(),
					(cause) => toError(cause, 'Unable to close agent status stream')
				)();
			};

			call.on('data', (res) => {
				controller.enqueue(sseFrame(toAgentStatusChunk(res)));
			});
			call.on('error', (streamErr) => {
				logger.withError(streamErr).warn('agent status stream failed');
				controller.enqueue(
					sseFrame({
						statuses: sessionIds.map(unavailableAgentStatus)
					})
				);
				close();
			});
			call.on('end', close);
			event.request.signal.addEventListener(
				'abort',
				() => {
					call.cancel();
					close();
				},
				{
					once: true
				}
			);
		}
	});

	return new Response(stream, {
		headers: {
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Content-Type': 'text/event-stream; charset=utf-8'
		}
	});
};
