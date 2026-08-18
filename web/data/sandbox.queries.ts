import { cacheLife, cacheTag } from "next/cache"
import { listSandboxes, type ListSandboxesData } from "@/lib/gateway/client"
import type { ListSandboxActionResponse } from "@/data/types"
import { sandboxesTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listSandboxesCachedQuery(
  query?: ListSandboxesData["query"],
  workspaceId?: string
): Promise<ListSandboxActionResponse> {
  "use cache: private"

  cacheLife("hours")
  cacheTag(sandboxesTag, `${sandboxesTag}:${workspaceId ?? "organization"}`)

  const { data, error } = await listSandboxes({
    query,
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
  if (error) {
    return {
      sandboxes: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error,
    }
  }

  const sandboxes = data.sandboxes
  const nextPageToken = data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    sandboxes,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
