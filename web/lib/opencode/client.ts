import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from "@opencode-ai/sdk/v2/client"
import { gatewayBaseURL } from "@/lib/gateway/base-url"
import { GATEWAY_UNAUTHORIZED } from "@/lib/gateway/errors"
import { getGatewayToken } from "@/lib/gateway/token-action"
import { clientRedirectToLogin } from "@/lib/login-redirect"

const gatewayBase = gatewayBaseURL()

function opencodeBaseURL(agentName: string): string {
  return `${gatewayBase}/api/opencode/${encodeURIComponent(agentName)}`
}

async function opencodeHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getGatewayToken()
    return { Authorization: `Bearer ${token}` }
  } catch (error) {
    if (error instanceof Error && error.message === GATEWAY_UNAUTHORIZED) {
      clientRedirectToLogin()
    }
    throw error
  }
}

// createAgentOpencodeClient builds an OpenCode SDK client for a single agent.
export async function createAgentOpencodeClient(
  agentName: string,
  directory?: string
): Promise<OpencodeClient> {
  return createOpencodeClient({
    baseUrl: opencodeBaseURL(agentName),
    headers: await opencodeHeaders(),
    ...(directory ? { directory } : {}),
  })
}

// createAgentOpencodeClientV2 builds an OpenCode v2 SDK client for one agent.
export async function createAgentOpencodeClientV2(agentName: string): Promise<OpencodeClientV2> {
  return createOpencodeClientV2({
    baseUrl: opencodeBaseURL(agentName),
    headers: await opencodeHeaders(),
  })
}
