"use server"

import { randomUUID } from "node:crypto"
import { defaultKeyHasher } from "@better-auth/api-key"
import { generateRandomString } from "better-auth/crypto"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { updateTag } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import * as z from "zod"
import { createAPIKeyFormSchema } from "@/data/api-key.schema"
import { getWorkspaceAPIKeyAccess } from "@/data/api-key.queries"
import { apiKeysTag } from "@/data/cache"
import type { CreateAPIKeyFormState, DeleteAPIKeyFormState } from "@/data/types"
import { getDB, schema } from "@/db"
import { agentAPIKeyConfigID, webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getAuth } from "@/lib/auth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { listAgents, listWorkflowSummaries } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"

const deleteAPIKeyFormSchema = z.object({
  keyID: z.string({ error: "API key ID is required" }).min(1, "API key ID is required"),
})

export type APIKeyActionScope = {
  workspaceId: string
}

export async function createAPIKeyFormAction(
  scope: APIKeyActionScope,
  _: CreateAPIKeyFormState,
  formData: FormData
): Promise<CreateAPIKeyFormState> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) {
    redirect(signInURL({ error: "session_expired" }))
  }

  const parsed = createAPIKeyFormSchema.safeParse({
    ...Object.fromEntries(formData),
    agentNames: formData.getAll("agentNames"),
    workflowAgentNames: formData.getAll("workflowAgentNames"),
    workflowNames: formData.getAll("workflowNames"),
  })
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: parsed.error.issues[0]?.message ?? "Invalid API key configuration",
      },
    }
  }

  const access = await getWorkspaceAPIKeyAccess(scope.workspaceId)
  if (!access) {
    return {
      error: { code: "FORBIDDEN", message: "You cannot access this Workspace." },
    }
  }

  const authContext = await currentGatewayAuthContext()
  const { data, error } = await listAgents({
    client: getGatewayServerClient(scope.workspaceId),
  })
  if (error) {
    return {
      error: { code: "API_KEY_CREATE_FAILED", message: "Failed to validate API key targets." },
    }
  }

  const agents = data.agents.filter((agent) => agent.status !== "DELETED")
  const allowedAgents = new Set(agents.map((agent) => agent.name))
  const agentNames = [...new Set(parsed.data.agentNames)].toSorted()
  for (const agentName of agentNames) {
    if (!allowedAgents.has(agentName)) {
      return {
        error: { code: "INVALID_FORM", message: `Agent ${agentName} is not accessible.` },
      }
    }
  }

  const workflowsByAgent = new Map<string, Set<string>>()
  for (let index = 0; index < parsed.data.workflowNames.length; index++) {
    const agentName = parsed.data.workflowAgentNames[index]
    const workflowName = parsed.data.workflowNames[index]
    if (!agentName || !workflowName || !allowedAgents.has(agentName)) {
      return {
        error: { code: "INVALID_FORM", message: "A selected workflow is not accessible." },
      }
    }
    const workflowNames = workflowsByAgent.get(agentName) ?? new Set<string>()
    workflowNames.add(workflowName)
    workflowsByAgent.set(agentName, workflowNames)
  }

  if (parsed.data.type === "webhook") {
    const workflowResults = await Promise.all(
      [...workflowsByAgent].map(async ([agentName, selectedNames]) => {
        const result = await listWorkflowSummaries({
          client: getGatewayServerClient(scope.workspaceId),
          path: { agentName },
        })
        return { agentName, selectedNames, result }
      })
    )
    for (const { agentName, selectedNames, result } of workflowResults) {
      if (result.error) {
        return {
          error: {
            code: "API_KEY_CREATE_FAILED",
            message: "Failed to validate API key targets.",
          },
        }
      }
      const allowedWorkflows = new Set(result.data.map((workflow) => workflow.workflow_name))
      for (const workflowName of selectedNames) {
        if (!allowedWorkflows.has(workflowName)) {
          return {
            error: {
              code: "INVALID_FORM",
              message: `Workflow ${agentName}/${workflowName} is not accessible.`,
            },
          }
        }
      }
    }
  }

  const configId = parsed.data.type === "agent" ? agentAPIKeyConfigID : webhookAPIKeyConfigID
  const prefix = parsed.data.type === "agent" ? "opk_" : "whk_"
  const secret = `${prefix}${generateRandomString(64, "a-z", "A-Z")}`
  const keyID = `apikey-${randomUUID()}`
  const now = new Date()
  const expiresAt =
    parsed.data.expiresInDays === "none"
      ? null
      : new Date(now.getTime() + Number(parsed.data.expiresInDays) * 24 * 60 * 60 * 1000)
  const targets: Array<typeof schema.apiKeyTargets.$inferInsert> =
    parsed.data.type === "agent"
      ? agentNames.map((agentName) => ({
          agentName,
          apiKeyId: keyID,
          targetType: "agent",
          workflowName: "",
        }))
      : [...workflowsByAgent].flatMap(([agentName, workflowNames]) =>
          [...workflowNames].toSorted().map((workflowName) => ({
            agentName,
            apiKeyId: keyID,
            targetType: "workflow",
            workflowName,
          }))
        )

  try {
    const hash = await defaultKeyHasher(secret)
    await getDB().transaction(async (tx) => {
      const [workspace] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, scope.workspaceId),
            eq(schema.workspaces.organizationId, authContext.organizationId),
            isNull(schema.workspaces.deletedAt)
          )
        )
        .for("update")
        .limit(1)
      if (!workspace) throw new Error("active Workspace is required")

      const [member] = await tx
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(
          and(
            eq(schema.members.organizationId, authContext.organizationId),
            eq(schema.members.userId, authContext.userId),
            isNull(schema.members.disabledAt)
          )
        )
        .for("update")
        .limit(1)
      if (!member) throw new Error("active Membership is required")
      const currentAccess = await getWorkspaceAPIKeyAccess(scope.workspaceId)
      if (!currentAccess) {
        throw new Error("Workspace access was revoked")
      }

      const targetAgents =
        parsed.data.type === "agent" ? agentNames : [...workflowsByAgent.keys()].toSorted()
      const owners = await tx
        .select({ agentName: schema.agentOwners.agentName })
        .from(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, authContext.organizationId),
            eq(schema.agentOwners.workspaceId, scope.workspaceId),
            inArray(schema.agentOwners.agentName, targetAgents)
          )
        )
        .for("share")
      if (owners.length !== targetAgents.length) throw new Error("API key target no longer exists")

      await tx.insert(schema.apikeys).values({
        configId,
        createdAt: now,
        enabled: true,
        expiresAt,
        id: keyID,
        key: hash,
        name: parsed.data.name,
        prefix,
        rateLimitEnabled: false,
        referenceId: authContext.organizationId,
        requestCount: 0,
        start: secret.slice(0, 10),
        updatedAt: now,
      })
      await tx.insert(schema.apiKeyScopes).values({
        apiKeyId: keyID,
        creatorUserId: authContext.userId,
        organizationId: authContext.organizationId,
        workspaceId: scope.workspaceId,
      })
      await tx.insert(schema.apiKeyTargets).values(targets)
      await tx.insert(schema.eventTrailEvents).values({
        actorId: authContext.userId,
        actorType: "user",
        action: "api_key.create",
        after: [
          { field: "name", value: parsed.data.name },
          { field: "state", value: "active" },
        ],
        category: "api_key",
        id: `event-trail-${randomUUID()}`,
        organizationId: authContext.organizationId,
        result: "succeeded",
        targetId: keyID,
        targetType: "api_key",
        workspaceId: scope.workspaceId,
      })
    })
  } catch {
    return {
      error: { code: "API_KEY_CREATE_FAILED", message: "Failed to create API key." },
    }
  }

  updateTag(apiKeysTag)
  return { key: { id: keyID, name: parsed.data.name, secret } }
}

async function deleteAPIKeyFormAction(
  scope: APIKeyActionScope,
  _: DeleteAPIKeyFormState,
  formData: FormData
): Promise<DeleteAPIKeyFormState> {
  const parsed = deleteAPIKeyFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid API key." } }
  }

  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) {
    redirect(signInURL({ error: "session_expired" }))
  }

  const authContext = await currentGatewayAuthContext()
  const result = await getDB().transaction(async (tx) => {
    const [key] = await tx
      .select({
        creatorUserId: schema.apiKeyScopes.creatorUserId,
        name: schema.apikeys.name,
        revokedAt: schema.apiKeyScopes.revokedAt,
      })
      .from(schema.apiKeyScopes)
      .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
      .where(
        and(
          eq(schema.apiKeyScopes.apiKeyId, parsed.data.keyID),
          eq(schema.apiKeyScopes.organizationId, authContext.organizationId),
          eq(schema.apiKeyScopes.workspaceId, scope.workspaceId)
        )
      )
      .for("update")
      .limit(1)
    if (!key) {
      return "not-found" as const
    }
    if (key.creatorUserId !== authContext.userId) {
      return "forbidden" as const
    }
    if (key.revokedAt) {
      return "revoked" as const
    }

    const now = new Date()
    await tx
      .update(schema.apiKeyScopes)
      .set({
        revokedAt: now,
        revokedReason: "Revoked from personal API key settings.",
      })
      .where(eq(schema.apiKeyScopes.apiKeyId, parsed.data.keyID))
    await tx
      .update(schema.apikeys)
      .set({ enabled: false, updatedAt: now })
      .where(eq(schema.apikeys.id, parsed.data.keyID))
    await tx.insert(schema.eventTrailEvents).values({
      actorId: authContext.userId,
      actorType: "user",
      action: "api_key.revoke",
      before: [
        { field: "name", value: key.name ?? "API key" },
        { field: "state", value: "active" },
      ],
      after: [
        { field: "name", value: key.name ?? "API key" },
        { field: "state", value: "revoked" },
      ],
      category: "api_key",
      id: `event-trail-${randomUUID()}`,
      organizationId: authContext.organizationId,
      result: "succeeded",
      targetId: parsed.data.keyID,
      targetType: "api_key",
      workspaceId: scope.workspaceId,
    })
    return "revoked" as const
  })

  if (result === "not-found") {
    return { error: { code: "INVALID_FORM", message: "Invalid API key." } }
  }
  if (result === "forbidden") {
    return { error: { code: "FORBIDDEN", message: "You cannot revoke this API key." } }
  }

  updateTag(apiKeysTag)
  return { success: true }
}

export async function deleteUserAPIKeyFormAction(
  state: DeleteAPIKeyFormState,
  formData: FormData
): Promise<DeleteAPIKeyFormState> {
  const parsed = deleteAPIKeyFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: { code: "INVALID_FORM", message: "Invalid API key." } }

  const auth = await currentGatewayAuthContext()
  const [scope] = await getDB()
    .select({ workspaceId: schema.apiKeyScopes.workspaceId })
    .from(schema.apiKeyScopes)
    .where(
      and(
        eq(schema.apiKeyScopes.apiKeyId, parsed.data.keyID),
        eq(schema.apiKeyScopes.organizationId, auth.organizationId),
        eq(schema.apiKeyScopes.creatorUserId, auth.userId)
      )
    )
    .limit(1)
  if (!scope) return { error: { code: "INVALID_FORM", message: "Invalid API key." } }

  return deleteAPIKeyFormAction({ workspaceId: scope.workspaceId }, state, formData)
}
