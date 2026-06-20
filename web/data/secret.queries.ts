import { cacheLife, cacheTag } from "next/cache"
import { listSecrets } from "@/lib/gateway/client"
import type { Error, SecretListItem } from "@/lib/gateway/client"
import { agentSecretsTag, secretsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

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
  agentName: string,
  query?: { limit?: number; page_token?: string }
): Promise<ListSecretsQueryResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(secretsTag, agentSecretsTag(agentName))

  const { data, error } = await listSecrets({
    client: gatewayServerClient,
    path: { agentName },
    query,
  })

  if (error) {
    return {
      items: undefined,
      error,
    }
  }

  const items = data.items
  const nextPageToken = data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    items,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
