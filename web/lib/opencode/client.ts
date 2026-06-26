import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from "@opencode-ai/sdk/v2/client"
import { gatewayBaseURL } from "@/lib/gateway/base-url"
import { clientRedirectToLogin } from "@/lib/login-redirect"

function opencodeBaseURL(agentName: string): string {
  return `${gatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`
}

// Every non-navigation OpenCode path goes through fetch, so this is the
// narrow place to force logout on a revoked web session.
async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.status === 401) {
    clientRedirectToLogin()
    throw new Error("Unauthorized")
  }

  return response
}

async function gatewayAuthHeaders(): Promise<Record<string, string>> {
  const response = await authenticatedFetch("/api/gateway/token", {
    cache: "no-store",
    credentials: "same-origin",
  })

  if (!response.ok) {
    throw new Error("Failed to load gateway token")
  }

  const body = (await response.json()) as { token?: string }
  if (!body.token) {
    throw new Error("Failed to load gateway token")
  }

  return { Authorization: `Bearer ${body.token}` }
}

// createAgentOpencodeClient builds an OpenCode SDK client for a single agent.
export async function createAgentOpencodeClient(
  agentName: string,
  directory?: string
): Promise<OpencodeClient> {
  return createOpencodeClient({
    baseUrl: opencodeBaseURL(agentName),
    fetch: authenticatedFetch,
    headers: await gatewayAuthHeaders(),
    ...(directory ? { directory } : {}),
  })
}

// createAgentOpencodeClientV2 builds an OpenCode v2 SDK client for one agent.
export async function createAgentOpencodeClientV2(agentName: string): Promise<OpencodeClientV2> {
  return createOpencodeClientV2({
    baseUrl: opencodeBaseURL(agentName),
    fetch: authenticatedFetch,
    headers: await gatewayAuthHeaders(),
  })
}
