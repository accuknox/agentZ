import "server-only"

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, arrayContained, asc, eq, gt, inArray, isNotNull, isNull, not, sql } from "drizzle-orm"
import { z } from "zod"
import { getDB, schema } from "@/db"
import { getAuth, getAuthSession } from "@/lib/auth"
import { activateOrganization, isActiveSuperadmin } from "@/data/organizations"
import {
  checkDelegationSelection,
  delegationRequest,
  externalAgentAccess,
  type DelegationRequest,
} from "@/lib/delegation"
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider"
import { externalAgentCompatibility, oauthApplicationInput } from "@/data/schema"
import type { DelegationCatalog } from "@/lib/gateway/client"

/** saveOAuthApplication delegates protocol metadata and secret generation to Better Auth. */
export async function saveOAuthApplication(
  organizationId: string,
  input: z.input<typeof oauthApplicationInput>,
  clientId?: string
) {
  const data = oauthApplicationInput.parse(input)
  const session = await getAuthSession()
  if (!session || !(await isActiveSuperadmin(getDB(), organizationId, session.session.user.id)))
    throw new Error("Only an organization superadmin can manage applications.")
  await activateOrganization(organizationId)
  const grantTypes = [
    "refresh_token",
    ...data.loginMethods.map((method) =>
      method === "device_code" ? DEVICE_CODE_GRANT_TYPE : method
    ),
  ]
  const responseTypes: "code"[] = data.loginMethods.includes("authorization_code") ? ["code"] : []
  const auth = getAuth()
  let savedClientId: string
  let secret: string | undefined
  if (clientId) {
    const [client] = await getDB()
      .select()
      .from(schema.oauthClients)
      .where(
        and(
          eq(schema.oauthClients.clientId, clientId),
          eq(schema.oauthClients.referenceId, organizationId)
        )
      )
    if (!client) throw new Error("Application not found.")
    let registeredType = "confidential"
    if (client.tokenEndpointAuthMethod === "none") {
      registeredType = client.applicationType === "native" ? "native" : "browser"
    }
    if (registeredType !== data.type)
      throw new Error("Create a new application to change its client type.")
    await auth.api.adminUpdateOAuthClient({
      headers: session.requestHeaders,
      body: {
        client_id: clientId,
        update: {
          client_name: data.name,
          redirect_uris: data.redirectUris.length ? data.redirectUris : undefined,
          scope: data.scopes.join(" "),
          grant_types: grantTypes,
          response_types: responseTypes,
          skip_consent: false,
        },
      },
    })
    savedClientId = clientId
  } else {
    const client = await auth.api.adminCreateOAuthClient({
      headers: session.requestHeaders,
      body: {
        client_name: data.name,
        redirect_uris: data.redirectUris.length ? data.redirectUris : undefined,
        scope: data.scopes.join(" "),
        application_type: data.type === "native" ? "native" : "web",
        token_endpoint_auth_method: data.type === "confidential" ? "client_secret_basic" : "none",
        grant_types: grantTypes,
        response_types: responseTypes,
        require_pkce: true,
        skip_consent: false,
      },
    })
    savedClientId = client.client_id
    secret = client.client_secret
  }
  try {
    await getDB().transaction(async (tx) => {
      // Keep validated metadata and origins from the same save under the client lock.
      await tx
        .update(schema.oauthClients)
        .set({
          referenceId: organizationId,
          userId: null,
          name: data.name,
          redirectUris: data.redirectUris,
          scopes: data.scopes,
          grantTypes,
          responseTypes,
          skipConsent: false,
        })
        .where(eq(schema.oauthClients.clientId, savedClientId))
      await tx
        .delete(schema.oauthClientOrigins)
        .where(eq(schema.oauthClientOrigins.clientId, savedClientId))
      if (data.authorizedOrigins.length)
        await tx
          .insert(schema.oauthClientOrigins)
          .values(data.authorizedOrigins.map((origin) => ({ clientId: savedClientId, origin })))
      if (!clientId) return
      // A reduced scope ceiling immediately invalidates grants that exceed it.
      await tx
        .update(schema.delegationGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.delegationGrants.clientId, savedClientId),
            isNull(schema.delegationGrants.revokedAt),
            not(arrayContained(schema.delegationGrants.scopes, data.scopes))
          )
        )
    })
  } catch (error) {
    if (!clientId)
      await auth.api.deleteOAuthClient({
        headers: session.requestHeaders,
        body: { client_id: savedClientId },
      })
    throw error
  }
  return { clientId: savedClientId, secret }
}

/** changeOAuthApplication governs ownership before native deletion or rotation. */
export async function changeOAuthApplication(
  organizationId: string,
  clientId: string,
  operation: "delete" | "rotate" | "disable" | "enable"
) {
  const session = await getAuthSession()
  if (!session || !(await isActiveSuperadmin(getDB(), organizationId, session.session.user.id)))
    throw new Error("Only an organization superadmin can manage applications.")
  const [client] = await getDB()
    .select()
    .from(schema.oauthClients)
    .where(
      and(
        eq(schema.oauthClients.clientId, clientId),
        eq(schema.oauthClients.referenceId, organizationId)
      )
    )
  if (!client) throw new Error("Application not found.")
  await activateOrganization(organizationId)
  if (operation === "rotate") {
    if (client.tokenEndpointAuthMethod === "none")
      throw new Error("Public clients do not have a secret.")
    const rotated = await getAuth().api.rotateClientSecret({
      headers: session.requestHeaders,
      body: { client_id: clientId },
    })
    return { secret: rotated.client_secret }
  }
  if (operation === "delete") {
    await getAuth().api.deleteOAuthClient({
      headers: session.requestHeaders,
      body: { client_id: clientId },
    })
    return {}
  }
  await getDB().transaction(async (tx) => {
    await tx
      .update(schema.oauthClients)
      .set({ disabled: operation === "disable" })
      .where(eq(schema.oauthClients.clientId, clientId))
    if (operation === "disable") {
      await tx
        .update(schema.delegationGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.delegationGrants.clientId, clientId),
            isNull(schema.delegationGrants.revokedAt)
          )
        )
      await tx
        .delete(schema.delegationTransactions)
        .where(eq(schema.delegationTransactions.clientId, clientId))
      for (const table of [
        schema.oauthRefreshTokens,
        schema.oauthAccessTokens,
        schema.oauthConsents,
      ])
        await tx.delete(table).where(eq(table.clientId, clientId))
    }
  })
  return {}
}

/** setOrganizationDelegation turns off resource grants permanently until fresh consent. */
export async function setOrganizationDelegation(organizationId: string, enabled: boolean) {
  const session = await getAuthSession()
  if (!session || !(await isActiveSuperadmin(getDB(), organizationId, session.session.user.id)))
    throw new Error("Only an organization superadmin can change resource delegation.")
  await getDB().transaction(async (tx) => {
    await tx
      .insert(schema.organizationDelegation)
      .values({ organizationId, enabled })
      .onConflictDoUpdate({
        target: schema.organizationDelegation.organizationId,
        set: { enabled },
      })
    await tx
      .select({
        notification: sql`pg_notify('agentz_external_agents', ${schema.externalAgents.workspaceId})`,
      })
      .from(schema.externalAgents)
      .where(eq(schema.externalAgents.organizationId, organizationId))
    if (enabled) return
    const revoked = await tx
      .update(schema.delegationGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.delegationGrants.organizationId, organizationId),
          isNull(schema.delegationGrants.revokedAt)
        )
      )
      .returning({ id: schema.delegationGrants.id })
    const ids = revoked.map((grant) => grant.id)
    if (!ids.length) return
    await tx
      .delete(schema.delegationTransactions)
      .where(inArray(schema.delegationTransactions.grantId, ids))
    for (const table of [schema.oauthRefreshTokens, schema.oauthAccessTokens, schema.oauthConsents])
      await tx.delete(table).where(inArray(table.referenceId, ids))
  })
}

/** disconnectOAuthApplication revokes every snapshot, pending request and token family for this user and client. */
export async function disconnectOAuthApplication(clientId: string) {
  const session = await getAuthSession()
  if (!session) throw new Error("Sign in to manage connected applications.")
  await revokeOAuthApplication(clientId, session.session.user.id)
}

/** revokeOAuthApplication removes a user's grants after the caller has checked management authority. */
export async function revokeOAuthApplication(clientId: string, userId: string) {
  await getDB().transaction(async (tx) => {
    // Consent approval takes the same lock. A concurrent approval must finish
    // before disconnect, or find its transaction removed afterwards.
    await tx
      .select({ clientId: schema.oauthClients.clientId })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId))
      .for("update")
    await tx
      .update(schema.delegationGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.delegationGrants.clientId, clientId),
          eq(schema.delegationGrants.userId, userId),
          isNull(schema.delegationGrants.revokedAt)
        )
      )
    await tx
      .delete(schema.delegationTransactions)
      .where(
        and(
          eq(schema.delegationTransactions.clientId, clientId),
          eq(schema.delegationTransactions.userId, userId)
        )
      )
    for (const table of [schema.oauthRefreshTokens, schema.oauthAccessTokens, schema.oauthConsents])
      await tx.delete(table).where(and(eq(table.clientId, clientId), eq(table.userId, userId)))
    await tx
      .select({
        notification: sql`pg_notify('agentz_external_agents', ${schema.externalAgents.workspaceId})`,
      })
      .from(schema.externalAgents)
      .where(eq(schema.externalAgents.clientId, clientId))
  })
}

/** approveDelegation records an immutable selection against one signed authorization request. */
export async function approveDelegation(
  request: DelegationRequest,
  organizationId: string | null,
  selection: DelegationCatalog
) {
  const session = await getAuthSession()
  if (!session) throw new Error("Sign in to continue.")
  const user = session.session.user
  const transaction = await delegationRequest(request, user.id, session.session.session.id)
  const agent = await externalAgentAccess(transaction.clientId, user)
  if (
    agent &&
    ((organizationId !== null && agent.organizationId !== organizationId) ||
      [...selection.models, ...selection.mcp].some(
        (resource) => resource.workspace_id !== agent.workspaceId
      ))
  )
    throw new Error("This agent can only access its owner's selected workspace.")
  const inference = transaction.scopes.includes("inference:use")
  const mcp = transaction.scopes.includes("mcp:use")
  if ((!inference && selection.models.length) || (!mcp && selection.mcp.length))
    throw new Error("The application did not request those resources.")
  if (!inference && !mcp && organizationId)
    throw new Error("Identity access does not require an organization.")
  if (!selection.models.length && !selection.mcp.length) organizationId = null
  if ((selection.models.length || selection.mcp.length) && !organizationId)
    throw new Error("Select an organization.")
  if (organizationId)
    selection = await checkDelegationSelection(organizationId, selection, user, "consent")
  if (agent && selection.models.some((model) => !externalAgentCompatibility(agent.kind, model)))
    throw new Error("A selected model does not support this coding agent.")
  // Display names and click order do not change authority. Preserve the stored
  // order when reusing a grant because it identifies the projected routes.
  function matchesSelection(previous: DelegationCatalog) {
    if (
      !isDeepStrictEqual(
        new Set(previous.models.map((model) => model.id)),
        new Set(selection.models.map((model) => model.id))
      ) ||
      previous.mcp.length !== selection.mcp.length
    )
      return false
    return previous.mcp.every((connection) => {
      const selected = selection.mcp.find((item) => item.id === connection.id)
      if (!selected) return false
      return (
        isDeepStrictEqual(new Set(connection.tools), new Set(selected.tools)) &&
        isDeepStrictEqual(new Set(connection.prompts), new Set(selected.prompts)) &&
        isDeepStrictEqual(new Set(connection.resources), new Set(selected.resources))
      )
    })
  }
  const grantId = await getDB().transaction(async (tx) => {
    const [client] = await tx
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, transaction.clientId))
      .for("update")
    if (
      !client ||
      client.disabled ||
      !transaction.scopes.every((scope) => client.scopes?.includes(scope))
    )
      throw new Error("This application is no longer available for the requested scopes.")
    if (organizationId) {
      const [setting] = await tx
        .select()
        .from(schema.organizationDelegation)
        .where(
          and(
            eq(schema.organizationDelegation.organizationId, organizationId),
            eq(schema.organizationDelegation.enabled, true)
          )
        )
        .for("update")
      if (!setting) throw new Error("This organization no longer allows resource delegation.")
    }
    let grantId: string | null = null
    if (transaction.type === "authorization_code") {
      const [pending] = await tx
        .select()
        .from(schema.delegationTransactions)
        .where(
          and(
            eq(schema.delegationTransactions.id, transaction.id),
            gt(schema.delegationTransactions.expiresAt, new Date())
          )
        )
        .for("update")
      if (!pending) throw new Error("Authorization request expired.")
      grantId = pending.grantId
    } else {
      const [pending] = await tx
        .select()
        .from(schema.deviceCodes)
        .where(
          and(
            eq(schema.deviceCodes.id, transaction.id),
            eq(schema.deviceCodes.userId, user.id),
            eq(schema.deviceCodes.oauthClientId, client.clientId),
            eq(schema.deviceCodes.status, "pending"),
            gt(schema.deviceCodes.expiresAt, new Date())
          )
        )
        .for("update")
      if (!pending || !client.grantTypes?.includes(DEVICE_CODE_GRANT_TYPE))
        throw new Error("This device request expired or is no longer allowed.")
      grantId = pending.referenceId
    }
    if (grantId) {
      const [grant] = await tx
        .select()
        .from(schema.delegationGrants)
        .where(
          and(eq(schema.delegationGrants.id, grantId), isNull(schema.delegationGrants.revokedAt))
        )
      if (!grant || grant.organizationId !== organizationId || !matchesSelection(grant.selection))
        throw new Error(
          "This request already has a different selection. Start again from the application."
        )
      return grant.id
    }
    const existing = await tx
      .select()
      .from(schema.delegationGrants)
      .where(
        and(
          eq(schema.delegationGrants.clientId, transaction.clientId),
          eq(schema.delegationGrants.userId, user.id),
          isNull(schema.delegationGrants.revokedAt),
          isNotNull(schema.delegationGrants.approvedAt)
        )
      )
      .orderBy(asc(schema.delegationGrants.createdAt))
    const same = existing.find(
      (grant) =>
        grant.organizationId === organizationId &&
        transaction.scopes.every((scope) => grant.scopes.includes(scope)) &&
        transaction.resources.every((resource) => grant.resources.includes(resource)) &&
        matchesSelection(grant.selection)
    )
    const id = same?.id ?? randomUUID()
    if (!same)
      await tx.insert(schema.delegationGrants).values({
        id,
        clientId: transaction.clientId,
        userId: user.id,
        organizationId,
        scopes: transaction.scopes,
        resources: transaction.resources,
        selection,
        approvedAt: new Date(),
      })
    if (agent)
      await tx.execute(sql`select pg_notify('agentz_external_agents', ${agent.workspaceId})`)
    if (transaction.type === "device_code") {
      await tx
        .update(schema.deviceCodes)
        .set({ referenceId: id, sessionId: session.session.session.id, status: "approved" })
        .where(eq(schema.deviceCodes.id, transaction.id))
      return id
    }
    await tx
      .update(schema.delegationTransactions)
      .set({ grantId: id })
      .where(eq(schema.delegationTransactions.id, transaction.id))
    return id
  })
  return { grantId }
}

/** denyDeviceDelegation rejects only a pending device owned by the signed-in account. */
export async function denyDeviceDelegation(
  request: Extract<DelegationRequest, { type: "device_code" }>
) {
  const session = await getAuthSession()
  if (!session) throw new Error("Sign in to continue.")
  const device = await delegationRequest(
    request,
    session.session.user.id,
    session.session.session.id
  )
  const denied = await getDB()
    .update(schema.deviceCodes)
    .set({ status: "denied" })
    .where(
      and(
        eq(schema.deviceCodes.id, device.id),
        eq(schema.deviceCodes.userId, session.session.user.id),
        eq(schema.deviceCodes.status, "pending"),
        gt(schema.deviceCodes.expiresAt, new Date())
      )
    )
    .returning({ id: schema.deviceCodes.id })
  if (!denied.length) throw new Error("This device request expired or was already used.")
}
