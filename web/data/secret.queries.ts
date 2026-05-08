import { cacheLife, cacheTag } from "next/cache"
import { listSecrets } from "@/lib/gateway/client"
import type { Error, SecretListItem } from "@/lib/gateway/client"
import { secretsTag, sessionSecretsTag } from "@/data/cache"

export type ListSecretsQueryResponse =
  | {
      items: SecretListItem[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      items: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export async function listSecretsCachedQuery(
  sessionID: string,
  query?: { limit?: number; page_token?: string }
): Promise<ListSecretsQueryResponse> {
  "use cache"

  cacheLife("minutes")
  cacheTag(secretsTag, sessionSecretsTag(sessionID))

  const result = await listSecrets({
    path: { sessionID },
    query,
  })

  if (result.error) {
    return {
      items: undefined,
      error: result.error,
    }
  }

  const items = result.data.items
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    items,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
