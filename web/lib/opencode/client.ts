import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { gatewayAuthenticatedFetch, getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

// createAgentOpencodeClient builds a browser OpenCode client that relies on
// gatewayAuthenticatedFetch to refresh scoped credentials when needed,
// including SDK-managed SSE reconnects.
export async function createAgentOpencodeClient(
  agentName: string,
  workspaceId: string
): Promise<OpencodeClient> {
  return createOpencodeClient({
    baseUrl: `${await getGatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`,
    fetch: gatewayAuthenticatedFetch,
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
  })
}
