import type { Handle, HandleServerError } from '@sveltejs/kit';
import { createLogger, getHttpLogLevel } from '$lib/server/logger';

export const handle: Handle = async ({ event, resolve }) => {
	const requestId = event.request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
	const startedAt = performance.now();
	const url = new URL(event.request.url);
	const logger = createLogger({
		method: event.request.method,
		path: url.pathname,
		requestId
	});

	event.locals.logger = logger;
	event.locals.requestId = requestId;

	logger.info('request started');

	const response = await resolve(event);
	const durationMs = Math.round(performance.now() - startedAt);
	const completionLog = logger.withMetadata({
		durationMs,
		status: response.status
	});

	response.headers.set('x-request-id', requestId);

	switch (getHttpLogLevel(response.status)) {
		case 'error':
			completionLog.error('request completed');
			break;
		case 'warn':
			completionLog.warn('request completed');
			break;
		default:
			completionLog.info('request completed');
			break;
	}

	return response;
};

export const handleError: HandleServerError = ({ error, event, status }) => {
	const logger =
		event.locals.logger ??
		createLogger({
			method: event.request.method,
			path: new URL(event.request.url).pathname,
			requestId: event.locals.requestId ?? crypto.randomUUID()
		});

	logger
		.withError(error)
		.withMetadata({
			status
		})
		.error('request failed with unhandled error');
};
