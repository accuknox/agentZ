import { cacheLife, cacheTag } from "next/cache"
import { listMcpConnections, type ListMcpConnectionsData } from "@/lib/gateway/client"
import type { Error, McpConnectionSummary } from "@/lib/gateway/client"
import { mcpsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type ListMcpConnectionsQueryResponse =
  | {
      mcpConnections: McpConnectionSummary[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      mcpConnections: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export async function listMcpConnectionsCachedQuery(
  query?: ListMcpConnectionsData["query"],
  workspaceId?: string
): Promise<ListMcpConnectionsQueryResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(mcpsTag, `${mcpsTag}:${workspaceId ?? "organization"}`)

  const { data, error } = await listMcpConnections({
    query,
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
  if (error) {
    return {
      mcpConnections: undefined,
      error,
    }
  }

  const nextPageToken = data.next_page_token
  return {
    mcpConnections: data.mcp_connections,
    nextPageToken,
    hasNextPage: nextPageToken.length > 0,
    error: undefined,
  }
}
