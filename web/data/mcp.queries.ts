import { cacheLife, cacheTag } from "next/cache"
import { listMcpConnections, type ListMcpConnectionsData } from "@/lib/gateway/client"
import type { Error, McpConnectionSummary } from "@/lib/gateway/client"
import { mcpsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

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
  query?: ListMcpConnectionsData["query"]
): Promise<ListMcpConnectionsQueryResponse> {
  "use cache"

  cacheLife("minutes")
  cacheTag(mcpsTag)

  const result = await listMcpConnections({ query, client: gatewayServerClient })
  if (result.error) {
    return {
      mcpConnections: undefined,
      error: result.error,
    }
  }

  const nextPageToken = result.data.next_page_token
  return {
    mcpConnections: result.data.mcp_connections,
    nextPageToken,
    hasNextPage: nextPageToken.length > 0,
    error: undefined,
  }
}
