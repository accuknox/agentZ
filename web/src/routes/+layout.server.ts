import type { LayoutServerLoad } from './$types';
import { listSessions } from '$lib/server/session/sessions';

export const load: LayoutServerLoad = async (event) => {
	const logger = event.locals.logger.child().withContext({
		routeId: '/',
		routeType: 'layout'
	});
	const sessions = await listSessions(logger).unwrapOr([]);

	return {
		sessions
	};
};
