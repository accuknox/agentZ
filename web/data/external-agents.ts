import { invalidateResource } from "@/data/page-selection"
import "server-only"

import { and, asc, count, eq, inArray, isNotNull, ne, sql } from "drizzle-orm"
import { z } from "zod"
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider"
import { getDB, schema } from "@/db"
import { getAuth, getAuthSession } from "@/lib/auth"
import { getWorkspaceScope } from "@/data/workspaces"
import { delegationScopes, externalAgentInput } from "@/data/schema"
import { revokeOAuthApplication } from "@/data/delegations"
import type { DelegationCatalog } from "@/lib/gateway/client"

/** listExternalAgents lists workspace registrations and their approved resource grants. */
export async function listExternalAgents(
  orgSlug: string,
  workspaceSlug: string,
  clientIds?: string[]
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.external_agents.read) return null
  const session = await getAuthSession()
  if (!session) return null
  const administer = scope.scope.organization.superadmin || scope.workspace.capabilities.administer
  const [settings, agents, integrations] = await Promise.all([
    clientIds
      ? []
      : getDB()
          .select({ enabled: schema.organizationDelegation.enabled })
          .from(schema.organizationDelegation)
          .where(eq(schema.organizationDelegation.organizationId, scope.scope.organization.id)),
    getDB()
      .select({
        clientId: schema.externalAgents.clientId,
        kind: schema.externalAgents.kind,
        name: schema.oauthClients.name,
        createdAt: schema.externalAgents.createdAt,
        disabled: schema.oauthClients.disabled,
        environmentEnabled: schema.copilotStudioIntegrations.enabled,
        copilotStudioAgentId: schema.copilotStudioAgents.agentId,
        lastActiveAt: schema.copilotStudioAgents.lastSeenAt,
        user: {
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          image: schema.users.image,
        },
      })
      .from(schema.externalAgents)
      .innerJoin(
        schema.oauthClients,
        eq(schema.oauthClients.clientId, schema.externalAgents.clientId)
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.externalAgents.userId))
      .leftJoin(
        schema.copilotStudioAgents,
        eq(schema.copilotStudioAgents.clientId, schema.externalAgents.clientId)
      )
      .leftJoin(
        schema.copilotStudioIntegrations,
        eq(schema.copilotStudioIntegrations.id, schema.copilotStudioAgents.integrationId)
      )
      .where(
        and(
          eq(schema.externalAgents.workspaceId, scope.workspace.id),
          administer ? undefined : eq(schema.externalAgents.userId, session.session.user.id),
          clientIds
            ? inArray(schema.externalAgents.clientId, clientIds)
            : ne(schema.externalAgents.kind, "microsoft-copilot-studio")
        )
      )
      .orderBy(asc(schema.externalAgents.createdAt), asc(schema.externalAgents.clientId)),
    clientIds
      ? []
      : getDB()
          .select({
            id: schema.copilotStudioIntegrations.id,
            name: schema.copilotStudioIntegrations.name,
            enabled: schema.copilotStudioIntegrations.enabled,
            createdAt: schema.copilotStudioIntegrations.createdAt,
            validatedAt: schema.copilotStudioIntegrations.validatedAt,
            runtimeError: schema.copilotStudioIntegrations.runtimeError,
            agentCount: count(schema.externalAgents.clientId),
            user: {
              id: schema.users.id,
              name: schema.users.name,
              email: schema.users.email,
              image: schema.users.image,
            },
          })
          .from(schema.copilotStudioIntegrations)
          .innerJoin(schema.users, eq(schema.users.id, schema.copilotStudioIntegrations.userId))
          .leftJoin(
            schema.copilotStudioAgents,
            eq(schema.copilotStudioAgents.integrationId, schema.copilotStudioIntegrations.id)
          )
          .leftJoin(
            schema.externalAgents,
            and(
              eq(schema.externalAgents.clientId, schema.copilotStudioAgents.clientId),
              administer ? undefined : eq(schema.externalAgents.userId, session.session.user.id)
            )
          )
          .where(
            and(
              eq(schema.copilotStudioIntegrations.organizationId, scope.scope.organization.id),
              eq(schema.copilotStudioIntegrations.workspaceId, scope.workspace.id),
              administer ? undefined : isNotNull(schema.externalAgents.clientId)
            )
          )
          .groupBy(schema.copilotStudioIntegrations.id, schema.users.id)
          .orderBy(
            asc(schema.copilotStudioIntegrations.createdAt),
            asc(schema.copilotStudioIntegrations.id)
          ),
  ])
  const [setting] = settings
  const delegated = agents.filter((agent) => agent.kind !== "microsoft-copilot-studio")
  const grants = delegated.length
    ? await getDB()
        .select()
        .from(schema.delegationGrants)
        .where(
          and(
            inArray(
              schema.delegationGrants.clientId,
              delegated.map((agent) => agent.clientId)
            ),
            isNotNull(schema.delegationGrants.approvedAt)
          )
        )
        .orderBy(asc(schema.delegationGrants.createdAt))
    : []
  const grantsByClient = Map.groupBy(grants, (grant) => grant.clientId)
  return {
    workspace: scope.workspace,
    organization: scope.scope.organization,
    delegationEnabled: setting?.enabled ?? false,
    integrations: integrations.map((integration) => ({
      ...integration,
      createdAt: integration.createdAt.toISOString(),
      validatedAt: integration.validatedAt?.toISOString() ?? null,
      canModify: administer,
    })),
    agents: agents.map((agent) => {
      const history = grantsByClient.get(agent.clientId) ?? []
      const active = history.filter((grant) => !grant.revokedAt)
      const selection: DelegationCatalog = { models: [], mcp: [] }
      for (const grant of active) {
        for (const model of grant.selection.models) {
          if (!selection.models.some((selected) => selected.id === model.id))
            selection.models.push(model)
        }
        for (const connection of grant.selection.mcp) {
          const selected = selection.mcp.find((selected) => selected.id === connection.id)
          if (!selected) {
            selection.mcp.push({ ...connection })
            continue
          }
          for (const capability of ["tools", "prompts", "resources"] as const) {
            selected[capability] = [
              ...new Set([...selected[capability], ...connection[capability]]),
            ]
          }
        }
      }
      const own = agent.user.id === session.session.user.id
      return {
        ...agent,
        name: agent.name ?? "External agent",
        createdAt: agent.createdAt.toISOString(),
        lastActiveAt: agent.lastActiveAt?.toISOString() ?? null,
        own,
        canModify: (own || administer) && scope.workspace.capabilities.external_agents.modify,
        canDelete: (own || administer) && scope.workspace.capabilities.external_agents.delete,
        canDisconnect: own || (administer && scope.workspace.capabilities.external_agents.modify),
        connected:
          agent.kind === "microsoft-copilot-studio"
            ? !agent.disabled && agent.environmentEnabled === true
            : active.length > 0,
        connectedAt: active[0]?.createdAt.toISOString(),
        previouslyConnected: history.length > 0,
        scopes: [...new Set(active.flatMap((grant) => grant.scopes))],
        selection,
      }
    }),
  }
}

/** ExternalAgent is a workspace registration with its owner and current consent snapshots. */
export type ExternalAgent = NonNullable<
  Awaited<ReturnType<typeof listExternalAgents>>
>["agents"][number]

export type CopilotStudioEnvironment = NonNullable<
  Awaited<ReturnType<typeof listExternalAgents>>
>["integrations"][number]

/** getExternalAgentGuardrails limits policy assignments to workspace agent registrations. */
export async function getExternalAgentGuardrails(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") return
  if (!scope.scope.organization.superadmin && !scope.workspace.capabilities.administer) return
  const [agent] = await getDB()
    .select({
      policies: schema.guardrailClientAccess.policies,
      updatedAt: schema.guardrailClientAccess.updatedAt,
      environmentPolicies: schema.copilotStudioIntegrations.policies,
    })
    .from(schema.externalAgents)
    .leftJoin(
      schema.copilotStudioAgents,
      eq(schema.copilotStudioAgents.clientId, schema.externalAgents.clientId)
    )
    .leftJoin(
      schema.copilotStudioIntegrations,
      eq(schema.copilotStudioIntegrations.id, schema.copilotStudioAgents.integrationId)
    )
    .leftJoin(
      schema.guardrailClientAccess,
      and(
        eq(schema.guardrailClientAccess.clientId, schema.externalAgents.clientId),
        eq(schema.guardrailClientAccess.organizationId, schema.externalAgents.organizationId),
        eq(schema.guardrailClientAccess.workspaceId, schema.externalAgents.workspaceId)
      )
    )
    .where(
      and(
        eq(schema.externalAgents.clientId, clientId),
        eq(schema.externalAgents.organizationId, scope.scope.organization.id),
        eq(schema.externalAgents.workspaceId, scope.workspace.id)
      )
    )
  if (!agent) return
  return {
    organizationId: scope.scope.organization.id,
    workspaceId: scope.workspace.id,
    assignment: { policies: agent.policies ?? agent.environmentPolicies ?? [] },
    updatedAt: agent.updatedAt?.toISOString(),
  }
}

/** createExternalAgent registers fixed native OAuth metadata after workspace authorization. */
export async function createExternalAgent(
  orgSlug: string,
  workspaceSlug: string,
  input: z.input<typeof externalAgentInput>
) {
  const data = externalAgentInput.parse(input)
  if (data.kind === "microsoft-copilot-studio")
    throw new Error("Copilot Studio agents are discovered from an environment connection.")
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  const session = await getAuthSession()
  if (
    scope.kind !== "ready" ||
    scope.workspace.state !== "ready" ||
    !session ||
    !scope.workspace.capabilities.external_agents.create
  )
    throw new Error("You do not have permission to onboard agents in this workspace.")
  const headers = new Headers(session.requestHeaders)
  headers.set("X-AgentZ-Workspace-ID", scope.workspace.id)
  let callbacks: string[] | undefined
  let grants = [DEVICE_CODE_GRANT_TYPE, "refresh_token"]
  switch (data.kind) {
    case "claude":
      callbacks = ["http://localhost:8765/callback"]
      grants = ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE]
      break
    case "codex":
    case "chatgpt-desktop":
      callbacks = ["http://127.0.0.1:8766/callback", "http://127.0.0.1:8767/callback"]
      grants = ["authorization_code", "refresh_token"]
      break
  }
  const client = await getAuth().api.adminCreateOAuthClient({
    headers,
    body: {
      client_name: data.name,
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: callbacks,
      scope: delegationScopes.join(" "),
      grant_types: grants,
      response_types: callbacks ? ["code"] : undefined,
      require_pkce: true,
      skip_consent: false,
    },
  })
  try {
    await getDB().transaction(async (tx) => {
      await tx
        .update(schema.oauthClients)
        .set({ referenceId: scope.scope.organization.id, userId: session.session.user.id })
        .where(eq(schema.oauthClients.clientId, client.client_id))
      await tx.insert(schema.externalAgents).values({
        clientId: client.client_id,
        organizationId: scope.scope.organization.id,
        workspaceId: scope.workspace.id,
        userId: session.session.user.id,
        kind: data.kind,
      })
      await tx.execute(sql`select pg_notify('agentz_external_agents', ${scope.workspace.id})`)
    })
  } catch (error) {
    await getDB()
      .delete(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, client.client_id))
    throw error
  }
  return { clientId: client.client_id }
}

/** changeExternalAgent keeps mutations scoped to the owner or a workspace administrator. */
export async function changeExternalAgent(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string,
  operation: "rename" | "disconnect" | "reconnect" | "delete",
  name?: string
) {
  operation = z.enum(["rename", "disconnect", "reconnect", "delete"]).parse(operation)
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  const session = await getAuthSession()
  if (scope.kind !== "ready" || !session) throw new Error("Workspace unavailable.")
  const [agent] = await getDB()
    .select()
    .from(schema.externalAgents)
    .where(
      and(
        eq(schema.externalAgents.clientId, clientId),
        eq(schema.externalAgents.workspaceId, scope.workspace.id)
      )
    )
  if (!agent) throw new Error("Agent not found.")
  const own = agent.userId === session.session.user.id
  const administer = scope.scope.organization.superadmin || scope.workspace.capabilities.administer
  let allowed =
    operation === "delete"
      ? scope.workspace.capabilities.external_agents.delete
      : scope.workspace.capabilities.external_agents.modify
  if (operation === "disconnect" && own) allowed = true
  if (!allowed || (!own && !administer))
    throw new Error("You do not have permission to manage this agent.")
  if (operation === "reconnect" && agent.kind !== "microsoft-copilot-studio")
    throw new Error("Reconnect this agent through its normal sign-in flow.")
  if (operation === "rename") {
    const input = externalAgentInput.parse({ name, kind: agent.kind })
    await getDB().transaction(async (tx) => {
      await tx
        .update(schema.oauthClients)
        .set({ name: input.name })
        .where(eq(schema.oauthClients.clientId, clientId))
      await tx.execute(sql`select pg_notify('agentz_external_agents', ${agent.workspaceId})`)
    })
    return
  }
  if (operation === "delete") {
    await getDB().transaction(async (tx) => {
      await tx.delete(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId))
      await tx.execute(sql`select pg_notify('agentz_external_agents', ${agent.workspaceId})`)
    })
    await invalidateResource(scope.workspace.id, { app_client_id: clientId })
    return
  }
  if (agent.kind === "microsoft-copilot-studio") {
    await getDB().transaction(async (tx) => {
      await tx
        .update(schema.oauthClients)
        .set({ disabled: operation !== "reconnect" })
        .where(eq(schema.oauthClients.clientId, clientId))
      await tx.execute(sql`select pg_notify('agentz_external_agents', ${agent.workspaceId})`)
    })
    await invalidateResource(scope.workspace.id, { app_client_id: clientId })
    return
  }
  await revokeOAuthApplication(clientId, agent.userId)
}
