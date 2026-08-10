import "server-only"

import { redirect } from "next/navigation"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { signInURL } from "@/lib/sign-in-redirect"

type AgentOpencodeClientOptions = {
  directory?: string
  workspaceId?: string
}

// createAgentOpencodeClient builds an OpenCode SDK client for a single agent.
export async function createAgentOpencodeClient(
  agentName: string,
  options: AgentOpencodeClientOptions = {}
): Promise<OpencodeClient> {
  let gatewayToken: string
  try {
    gatewayToken = await currentGatewayAuthToken(options.workspaceId)
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError) {
      redirect(signInURL({ error: "session_expired" }))
    }
    throw error
  }

  return createOpencodeClient({
    baseUrl: `${serverGatewayBaseURL()}/api/opencode/${encodeURIComponent(agentName)}`,
    headers: { Authorization: `Bearer ${gatewayToken}` },
    ...(options.directory ? { directory: options.directory } : {}),
  })
}
