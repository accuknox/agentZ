import { cacheLife, cacheTag } from "next/cache"
import { listAgents, type Agent, type ListAgentsData } from "@/lib/gateway/client"
import type { ListAgentActionResponse } from "@/data/types"
import { agentsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

export async function listAgentsCachedQuery(
  query?: ListAgentsData["query"]
): Promise<ListAgentActionResponse> {
  "use cache"

  cacheLife("minutes")
  cacheTag(agentsTag)

  const result = await listAgents({ query, client: gatewayServerClient })
  if (result.error) {
    return {
      agents: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error: result.error,
    }
  }

  const agents = result.data.agents.filter((agent) => agent.status !== "DELETED")
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    agents,
    nextPageToken,
    hasNextPage,
    error: undefined,
  } satisfies ListAgentActionResponse<Agent>
}
