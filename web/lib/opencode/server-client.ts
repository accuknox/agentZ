import "server-only"

import { redirect } from "next/navigation"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { loginURL } from "@/lib/login-redirect"

// createAgentOpencodeClient builds an OpenCode SDK client for a single agent.
export async function createAgentOpencodeClient(
  agentName: string,
  directory?: string
): Promise<OpencodeClient> {
  let gatewayToken: string
  try {
    gatewayToken = await currentGatewayAuthToken()
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError) {
      redirect(loginURL({ error: "session_expired" }))
    }
    throw error
  }

  return createOpencodeClient({
    baseUrl: `${serverGatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`,
    headers: { Authorization: `Bearer ${gatewayToken}` },
    ...(directory ? { directory } : {}),
  })
}
