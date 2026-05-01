"use server"

import { type Agent, type Error, listAgents } from "@/lib/gateway/client"

export type ListAgentActionResponse =
  | {
      agents: Agent[]
      error: undefined
    }
  | {
      agents: undefined
      error: Error
    }

export async function listAgentsAction(): Promise<ListAgentActionResponse> {
  const result = await listAgents()
  if (result.error) {
    return { agents: undefined, error: result.error }
  }
  return {
    agents: result.data.agents.filter((agent) => agent.status !== "DELETED"),
    error: undefined,
  }
}
