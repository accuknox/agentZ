import { cacheLife, cacheTag } from "next/cache"
import { listAgents, type Agent, type ListAgentsData } from "@/lib/gateway/client"
import type { ListAgentActionResponse } from "@/data/types"
import { agentsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listAgentsCachedQuery(
  query?: ListAgentsData["query"]
): Promise<ListAgentActionResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentsTag)

  const { data, error } = await listAgents({ query, client: getGatewayServerClient() })
  if (error) {
    return {
      agents: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error,
    }
  }

  const agents = data.agents.filter((agent) => agent.status !== "DELETED")
  const nextPageToken = data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    agents,
    nextPageToken,
    hasNextPage,
    error: undefined,
  } satisfies ListAgentActionResponse<Agent>
}
