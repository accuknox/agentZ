import { cacheLife } from "next/cache"
import { headers } from "next/headers"
import { webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getAuth } from "@/lib/auth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"

type APIKeySummaryByID = Record<
  string,
  {
    display: string
    name?: string
  }
>

export async function listWebhookAPIKeyDisplaysCachedQuery(): Promise<APIKeySummaryByID> {
  "use cache: private"

  cacheLife("minutes")

  const auth = getAuth()
  const authContext = await currentGatewayAuthContext()
  const requestHeaders = await headers()
  const listedKeys = await auth.api.listApiKeys({
    headers: requestHeaders,
    query: {
      configId: webhookAPIKeyConfigID,
      organizationId: authContext.organizationId,
      sortBy: "createdAt",
      sortDirection: "desc",
    },
  })

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
