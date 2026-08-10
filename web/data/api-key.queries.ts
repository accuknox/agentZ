import { cacheLife, cacheTag } from "next/cache"
import { headers } from "next/headers"
import { and, eq } from "drizzle-orm"
import { webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getDB, schema } from "@/db"
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

export type APIKeyScopeSummary = {
  revokedAt: string | null
  revokedReason: string | null
}

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

export async function listAPIKeysCachedQuery(workspaceId?: string, includeAll = false) {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(apiKeysTag, `${apiKeysTag}:${workspaceId ?? "account"}`)

  const listed = await listAPIKeys()
  if (!workspaceId) {
    return listed
  }

  const authContext = await currentGatewayAuthContext()
  const rows = await getDB()
    .select({
      apiKeyId: schema.apiKeyScopes.apiKeyId,
      creatorUserId: schema.apiKeyScopes.creatorUserId,
      revokedAt: schema.apiKeyScopes.revokedAt,
      revokedReason: schema.apiKeyScopes.revokedReason,
    })
    .from(schema.apiKeyScopes)
    .where(
      and(
        eq(schema.apiKeyScopes.organizationId, authContext.organizationId),
        eq(schema.apiKeyScopes.workspaceId, workspaceId)
      )
    )
  const scopedKeys = new Map(rows.map((row) => [row.apiKeyId, row]))
  return {
    ...listed,
    apiKeys: listed.apiKeys
      .filter((key) => {
        const scope = scopedKeys.get(key.id)
        if (!scope) {
          return false
        }
        return includeAll || scope.creatorUserId === authContext.userId
      })
      .map((key) => {
        const scope = scopedKeys.get(key.id)
        return {
          ...key,
          workspaceScope: {
            revokedAt: scope?.revokedAt?.toISOString() ?? null,
            revokedReason: scope?.revokedReason ?? null,
          } satisfies APIKeyScopeSummary,
        }
      }),
  }
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
