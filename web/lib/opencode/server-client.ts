import "server-only"

import { redirect } from "next/navigation"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { loginURL } from "@/lib/login-redirect"

function opencodeBaseURL(agentName: string): string {
  return `${serverGatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`
}

async function opencodeHeaders(): Promise<Record<string, string>> {
  try {
    const token = await currentGatewayAuthToken()
    return { Authorization: `Bearer ${token}` }
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError) {
      redirect(loginURL({ error: "session_expired" }))
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
