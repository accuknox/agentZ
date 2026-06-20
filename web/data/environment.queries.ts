import { cacheLife, cacheTag } from "next/cache"
import { listEnvironments, type ListEnvironmentsData } from "@/lib/gateway/client"
import type { ListEnvironmentActionResponse } from "@/data/types"
import { environmentsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

export async function listEnvironmentsCachedQuery(
  query?: ListEnvironmentsData["query"]
): Promise<ListEnvironmentActionResponse> {
  "use cache: private"

  cacheLife("hours")
  cacheTag(environmentsTag)

  const { data, error } = await listEnvironments({ query, client: gatewayServerClient })
  if (error) {
    return {
      environments: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error,
    }
  }

  const environments = data.environments
  const nextPageToken = data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    environments,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
