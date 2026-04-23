import { env } from '$env/dynamic/private';
import { credentials } from '@grpc/grpc-js';
import { AgentGatewayServiceClient } from './gateway.js';

let client: AgentGatewayServiceClient | undefined;
let clientAddr: string | undefined;

function getAgentGatewayAddr(): string {
	const addr = env.AGENT_GATEWAY_ADDR?.trim();

	if (!addr) {
		throw new Error('AGENT_GATEWAY_ADDR is required');
	}

	return addr;
}

/**
 * Returns a shared agent gateway gRPC client for server-side use.
 */
export function getAgentGatewayClient(): AgentGatewayServiceClient {
	const addr = getAgentGatewayAddr();

	if (client && clientAddr === addr) {
		return client;
	}

	client = new AgentGatewayServiceClient(addr, credentials.createInsecure());
	clientAddr = addr;

	return client;
}
