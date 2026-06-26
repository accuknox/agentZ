import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from "@opencode-ai/sdk/v2/client"
import { gatewayAuthenticatedFetch, getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

// createAgentOpencodeClient builds an OpenCode SDK client for a single agent.
export async function createAgentOpencodeClient(
  agentName: string,
  directory?: string
): Promise<OpencodeClient> {
  const gatewayBaseURL = await getGatewayBaseURL()

  return createOpencodeClient({
    baseUrl: `${gatewayBaseURL}/api/opencode/${encodeURIComponent(agentName)}`,
    fetch: gatewayAuthenticatedFetch,
    ...(directory ? { directory } : {}),
  })
}

// createAgentOpencodeClientV2 builds an OpenCode v2 SDK client for one agent.
export async function createAgentOpencodeClientV2(agentName: string): Promise<OpencodeClientV2> {
  const gatewayBaseURL = await getGatewayBaseURL()

  return createOpencodeClientV2({
    baseUrl: `${gatewayBaseURL}/api/opencode/${encodeURIComponent(agentName)}`,
    fetch: gatewayAuthenticatedFetch,
  })
}
