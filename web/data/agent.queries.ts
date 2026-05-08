import { cacheLife, cacheTag } from "next/cache"
import { listAgents, type Agent, type ListAgent, type ListAgentsData } from "@/lib/gateway/client"
import type { ListAgentActionResponse, ListAgentWithConfigActionResponse } from "@/data/types"
import { agentsTag } from "@/data/cache"

export async function listAgentsCachedQuery(): Promise<ListAgentActionResponse>
export async function listAgentsCachedQuery(
  includeConfig: false,
  query?: ListAgentsData["query"]
): Promise<ListAgentActionResponse>
export async function listAgentsCachedQuery(
  includeConfig: true,
  query?: ListAgentsData["query"]
): Promise<ListAgentWithConfigActionResponse>
export async function listAgentsCachedQuery(
  includeConfig = false,
  query?: ListAgentsData["query"]
) {
  "use cache"

  cacheLife("minutes")
  cacheTag(agentsTag)

  const result = await listAgents({ query })
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

  if (includeConfig) {
    return {
      agents,
      nextPageToken,
      hasNextPage,
      error: undefined,
    } satisfies ListAgentActionResponse<ListAgent>
  }

  return {
    agents: agents.map(({ configuration: _, ...agent }) => agent),
    nextPageToken,
    hasNextPage,
    error: undefined,
  } satisfies ListAgentActionResponse<Agent>
}
