import { env } from '$env/dynamic/private';
import { credentials } from '@grpc/grpc-js';
import { SessionServiceClient } from './session.js';

let client: SessionServiceClient | undefined;
let clientAddr: string | undefined;

function getSessionAddr(): string {
	const addr = env.SESSION_ADDR?.trim();

	if (!addr) {
		throw new Error('SESSION_ADDR is required');
	}

	return addr;
}

/**
 * Returns a shared session service gRPC client for server-side use.
 */
export function getSessionClient(): SessionServiceClient {
	const addr = getSessionAddr();

	if (client && clientAddr === addr) {
		return client;
	}

	client = new SessionServiceClient(addr, credentials.createInsecure());
	clientAddr = addr;

	return client;
}
