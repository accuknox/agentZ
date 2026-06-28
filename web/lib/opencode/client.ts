import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { gatewayAuthenticatedFetch, getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

// createAgentOpencodeClient builds a browser OpenCode client that relies on
// gatewayAuthenticatedFetch to mint a fresh 2-minute bearer for every request
// and SSE reconnect instead of caching Authorization at client creation time.
export async function createAgentOpencodeClient(agentName: string): Promise<OpencodeClient> {
  return createOpencodeClient({
    baseUrl: `${await getGatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`,
    fetch: gatewayAuthenticatedFetch,
  })
}
