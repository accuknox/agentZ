import { cacheLife, cacheTag } from "next/cache"
import {
  listInferencePools,
  type Error as GatewayError,
  type InferencePool,
} from "@/lib/gateway/client"
import { inferencePoolsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type InferencePoolsResult =
  | { pools: InferencePool[]; error: undefined }
  | { pools: undefined; error: GatewayError }

export type InferencePoolsPageResult =
  | {
      pools: InferencePool[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      pools: undefined
      nextPageToken: undefined
      hasNextPage: undefined
      error: GatewayError
    }

export async function listInferencePoolsPageCachedQuery(
  query: { limit: number; page_token?: string },
  workspaceId: string
): Promise<InferencePoolsPageResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(inferencePoolsTag, `${inferencePoolsTag}:${workspaceId}`)

  const { data, error } = await listInferencePools({
    query,
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
  })
  if (error) {
    return {
      pools: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error,
    }
  }

  return {
    pools: data.pools,
    nextPageToken: data.next_page_token,
    hasNextPage: data.next_page_token.length > 0,
    error: undefined,
  }
}

export async function listInferencePoolsCachedQuery(
  workspaceId: string
): Promise<InferencePoolsResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(inferencePoolsTag, `${inferencePoolsTag}:${workspaceId}`)

  const pools: InferencePool[] = []
  let pageToken: string | undefined
  do {
    const { data, error } = await listInferencePools({
      query: { limit: 200, page_token: pageToken },
      client: getGatewayServerClient(workspaceId),
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
    })
    if (error) {
      return { pools: undefined, error }
    }
    pools.push(...data.pools)
    pageToken = data.next_page_token || undefined
  } while (pageToken)

  return { pools, error: undefined }
}
