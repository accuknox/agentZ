import { cacheLife, cacheTag } from "next/cache"
import { headers } from "next/headers"
import { webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getAuth } from "@/lib/auth"
import { apiKeysTag } from "@/data/cache"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"

type APIKeySummaryByID = Record<
  string,
  {
    display: string
    name?: string
  }
>

async function listAPIKeys(configId?: string) {
  const requestHeaders = await headers()
  const auth = getAuth()
  const authContext = await currentGatewayAuthContext()

  return auth.api.listApiKeys({
    headers: requestHeaders,
    query: {
      configId,
      organizationId: authContext.organizationId,
      sortBy: "createdAt",
      sortDirection: "desc",
    },
  })
}

export async function listAPIKeysCachedQuery() {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(apiKeysTag)

  return listAPIKeys()
}

export async function listWebhookAPIKeyDisplaysCachedQuery(): Promise<APIKeySummaryByID> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(apiKeysTag)

  const listedKeys = await listAPIKeys(webhookAPIKeyConfigID)

  const displaysByID: APIKeySummaryByID = {}
  for (const key of listedKeys.apiKeys) {
    const start = key.start?.trim()
    const prefix = key.prefix?.trim()
    const display = start || prefix
    if (!display) {
      continue
    }
    displaysByID[key.id] = {
      display: `${display}...`,
      name: key.name?.trim() || undefined,
    }
  }

  return displaysByID
}
