import { ResultAsync } from 'neverthrow';
import type { AppLogger } from '$lib/server/logger';
import type { SessionSummary } from '$lib/session';
import { getSessionClient } from './client';

function toSessionSummary(session: {
	sessionId: string;
	agentName: string;
	createdAt: Date | undefined;
	updatedAt: Date | undefined;
}): SessionSummary {
	return {
		sessionId: session.sessionId,
		agentName: session.agentName,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt
	};
}

/**
 * Lists persisted sessions from the session service.
 */
export function listSessions(logger?: AppLogger): ResultAsync<SessionSummary[], Error> {
	return ResultAsync.fromPromise(
		new Promise<SessionSummary[]>((resolve, reject) => {
			getSessionClient().listSessions({}, (err, res) => {
				if (err) {
					reject(err);
					return;
				}

				resolve(res.sessions.map(toSessionSummary));
			});
		}),
		(err) =>
			err instanceof Error
				? err
				: new Error('Unable to list sessions', {
						cause: err
					})
	).mapErr((err) => {
		logger?.withError(err).error('failed to list sessions');
		return err;
	});
}
