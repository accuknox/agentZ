import { cacheLife, cacheTag } from "next/cache"
import { listEnvironments, type ListEnvironmentsData } from "@/lib/gateway/client"
import type { ListEnvironmentActionResponse } from "@/data/types"
import { environmentsTag } from "@/data/cache"

export async function listEnvironmentsCachedQuery(
  query?: ListEnvironmentsData["query"]
): Promise<ListEnvironmentActionResponse> {
  "use cache"

  cacheLife("hours")
  cacheTag(environmentsTag)

  const result = await listEnvironments({ query })
  if (result.error) {
    return {
      environments: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error: result.error,
    }
  }

  const environments = result.data.environments
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    environments,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
