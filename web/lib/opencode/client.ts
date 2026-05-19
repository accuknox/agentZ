import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from "@opencode-ai/sdk/v2/client"

function gatewayBaseURL() {
  const baseURL = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL
  if (!baseURL) {
    throw new Error("NEXT_PUBLIC_GATEWAY_BASE_URL is not configured")
  }

  return baseURL
}

function opencodeBaseURL(agentName: string) {
  return `${gatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`
}

// createAgentOpencodeClient builds an OpenCode SDK client for a single agent.
export function createAgentOpencodeClient(agentName: string, directory?: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: opencodeBaseURL(agentName),
    ...(directory ? { directory } : {}),
  })
}

// createAgentOpencodeClientV2 builds an OpenCode v2 SDK client for one agent.
export function createAgentOpencodeClientV2(agentName: string): OpencodeClientV2 {
  return createOpencodeClientV2({
    baseUrl: opencodeBaseURL(agentName),
  })
}
