import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { LogLayer, StructuredTransport, type LogLevelType } from 'loglayer';

const logLevels = new Set<LogLevelType>(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export type AppLogger = LogLayer;

function getLogLevel(): LogLevelType {
	const value = env.LOG_LEVEL?.trim().toLowerCase();

	if (value && logLevels.has(value as LogLevelType)) {
		return value as LogLevelType;
	}

	return dev ? 'debug' : 'info';
}

function serializeCause(err: unknown, depth = 0): unknown {
	if (!(err instanceof Error)) {
		return err;
	}

	if (depth >= 3) {
		return {
			message: err.message,
			name: err.name
		};
	}

	return {
		cause: serializeCause(err.cause, depth + 1),
		message: err.message,
		name: err.name,
		stack: err.stack
	};
}

function serializeError(err: unknown): Record<string, unknown> {
	if (!(err instanceof Error)) {
		return {
			value: err
		};
	}

	return {
		cause: serializeCause(err.cause),
		message: err.message,
		name: err.name,
		stack: err.stack
	};
}

const rootLogger = new LogLayer({
	contextFieldName: 'context',
	errorFieldName: 'error',
	errorSerializer: serializeError,
	metadataFieldName: 'metadata',
	transport: new StructuredTransport({
		level: getLogLevel(),
		logger: console,
		stringify: true
	})
});

/**
 * Returns a child logger with optional request or operation context.
 */
export function createLogger(context?: Record<string, unknown>, parent?: AppLogger): AppLogger {
	const logger = parent?.child() ?? rootLogger.child();

	if (context) {
		logger.withContext(context);
	}

	return logger;
}

/**
 * Maps HTTP response status to the request completion log level.
 */
export function getHttpLogLevel(status: number): LogLevelType {
	if (status >= 500) {
		return 'error';
	}

	if (status >= 400) {
		return 'warn';
	}

	return 'info';
}
