import "server-only"

import { listAgents, type Agent } from "@/lib/gateway/client"
import { zAgentName } from "@/lib/gateway/client/zod.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function agentForSkills(agentName: string): Promise<Agent> {
  const name = zAgentName.parse(agentName)
  const result = await listAgents({
    client: getGatewayServerClient(),
    query: {
      agent_name: [name],
      limit: 1,
    },
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  const agent = result.data.agents.find((item) => item.name === name)
  if (!agent) {
    throw new Error("agent not found")
  }
  if (!agent.home_storage_prefix) {
    throw new Error("agent home is not ready")
  }
  return agent
}
