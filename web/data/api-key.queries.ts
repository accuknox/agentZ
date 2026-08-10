import "server-only"

import { cacheLife, cacheTag } from "next/cache"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { apiKeysTag } from "@/data/cache"
import { getDB, schema } from "@/db"
import { agentAPIKeyConfigID, webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { listWorkspaces, type ResourceCapabilities } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type APIKeySummaryByID = Record<
  string,
  {
    display: string
    name?: string
  }
>

export type WorkspaceAPIKeyTarget = {
  targetType: "agent" | "workflow"
  agentName: string
  workflowName: string
}

export type WorkspaceAPIKey = {
  id: string
  name: string | null
  prefix: string | null
  expiresAt: Date | null
  createdAt: Date
  creatorUserId: string
  creatorName: string
  creatorEmail: string
  enabled: boolean | null
  revokedAt: string | null
  revokedReason: string | null
  targets: WorkspaceAPIKeyTarget[]
}

export type WorkspaceAPIKeyAccess = {
  canAdminister: boolean
  capabilities: ResourceCapabilities
}

export async function getWorkspaceAPIKeyAccess(
  workspaceId: string
): Promise<WorkspaceAPIKeyAccess | undefined> {
  const result = await listWorkspaces({ client: getGatewayServerClient() })
  if (result.error) {
    throw new Error(result.error.message)
  }

  const workspace = result.data.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) {
    return
  }

  return {
    canAdminister: workspace.can_administer,
    capabilities: workspace.api_key_capabilities,
  }
}

export async function listAPIKeysCachedQuery(workspaceId: string) {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(apiKeysTag, `${apiKeysTag}:${workspaceId}`)

  const access = await getWorkspaceAPIKeyAccess(workspaceId)
  if (!access?.capabilities.read) {
    return { access, apiKeys: [] satisfies WorkspaceAPIKey[] }
  }

  const auth = await currentGatewayAuthContext()
  const rows = await getDB()
    .select({
      id: schema.apikeys.id,
      name: schema.apikeys.name,
      prefix: schema.apikeys.prefix,
      expiresAt: schema.apikeys.expiresAt,
      createdAt: schema.apikeys.createdAt,
      creatorUserId: schema.apiKeyScopes.creatorUserId,
      creatorName: schema.users.name,
      creatorEmail: schema.users.email,
      enabled: schema.apikeys.enabled,
      revokedAt: schema.apiKeyScopes.revokedAt,
      revokedReason: schema.apiKeyScopes.revokedReason,
      targetType: schema.apiKeyTargets.targetType,
      agentName: schema.apiKeyTargets.agentName,
      workflowName: schema.apiKeyTargets.workflowName,
    })
    .from(schema.apiKeyScopes)
    .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
    .innerJoin(schema.users, eq(schema.users.id, schema.apiKeyScopes.creatorUserId))
    .innerJoin(
      schema.apiKeyTargets,
      eq(schema.apiKeyTargets.apiKeyId, schema.apiKeyScopes.apiKeyId)
    )
    .where(
      and(
        eq(schema.apiKeyScopes.organizationId, auth.organizationId),
        eq(schema.apiKeyScopes.workspaceId, workspaceId),
        inArray(schema.apikeys.configId, [agentAPIKeyConfigID, webhookAPIKeyConfigID]),
        access.canAdminister ? undefined : eq(schema.apiKeyScopes.creatorUserId, auth.userId)
      )
    )
    .orderBy(desc(schema.apikeys.createdAt), desc(schema.apikeys.id))

  const apiKeys: WorkspaceAPIKey[] = []
  const keysByID = new Map<string, WorkspaceAPIKey>()
  for (const row of rows) {
    const target = {
      targetType: row.targetType,
      agentName: row.agentName,
      workflowName: row.workflowName,
    }
    const key = keysByID.get(row.id)
    if (key) {
      key.targets.push(target)
      continue
    }

    const created = {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      creatorUserId: row.creatorUserId,
      creatorName: row.creatorName,
      creatorEmail: row.creatorEmail,
      enabled: row.enabled,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedReason: row.revokedReason,
      targets: [target],
    }
    keysByID.set(row.id, created)
    apiKeys.push(created)
  }

  return { access, apiKeys }
}

export async function listWebhookAPIKeyDisplaysCachedQuery(
  workspaceId: string
): Promise<APIKeySummaryByID> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(apiKeysTag)

  const auth = await currentGatewayAuthContext()
  const keys = await getDB()
    .select({
      id: schema.apikeys.id,
      name: schema.apikeys.name,
      prefix: schema.apikeys.prefix,
    })
    .from(schema.apiKeyScopes)
    .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
    .where(
      and(
        eq(schema.apiKeyScopes.organizationId, auth.organizationId),
        eq(schema.apiKeyScopes.workspaceId, workspaceId),
        eq(schema.apiKeyScopes.creatorUserId, auth.userId),
        eq(schema.apikeys.configId, webhookAPIKeyConfigID),
        eq(schema.apikeys.enabled, true),
        isNull(schema.apiKeyScopes.revokedAt)
      )
    )

  const displaysByID: APIKeySummaryByID = {}
  for (const key of keys) {
    const display = key.prefix
    if (!display) {
      continue
    }
    displaysByID[key.id] = {
      display: `${display}...${key.id.slice(-6)}`,
      name: key.name || undefined,
    }
  }

  return displaysByID
}
