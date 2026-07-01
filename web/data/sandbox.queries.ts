import { cacheLife, cacheTag } from "next/cache"
import { listSandboxes, type ListSandboxesData } from "@/lib/gateway/client"
import type { ListSandboxActionResponse } from "@/data/types"
import { sandboxesTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listSandboxesCachedQuery(
  query?: ListSandboxesData["query"]
): Promise<ListSandboxActionResponse> {
  "use cache: private"

  cacheLife("hours")
  cacheTag(sandboxesTag)

  const { data, error } = await listSandboxes({ query, client: getGatewayServerClient() })
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
