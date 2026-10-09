import "server-only"

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm"
import { z } from "zod"
import { getDB, schema } from "@/db"
import { getAuth, getAuthSession } from "@/lib/auth"
import { activateOrganization, isActiveSuperadmin } from "@/data/organizations"
import { checkDelegationSelection, delegationTransaction } from "@/lib/delegation"
import { oauthApplicationInput } from "@/data/schema"
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
          redirect_uris: data.redirectUris,
          scope: data.scopes.join(" "),
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
        redirect_uris: data.redirectUris,
        scope: data.scopes.join(" "),
        application_type: data.type === "native" ? "native" : "web",
        token_endpoint_auth_method: data.type === "confidential" ? "client_secret_basic" : "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
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
      const grants = await tx
        .select()
        .from(schema.delegationGrants)
        .where(
          and(
            eq(schema.delegationGrants.clientId, savedClientId),
            isNull(schema.delegationGrants.revokedAt)
          )
        )
      const revoked = grants
        .filter((grant) => !grant.scopes.every((scope) => data.scopes.includes(scope)))
        .map((grant) => grant.id)
      if (revoked.length)
        await tx
          .update(schema.delegationGrants)
          .set({ revokedAt: new Date() })
          .where(inArray(schema.delegationGrants.id, revoked))
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
      await tx
        .delete(schema.oauthRefreshTokens)
        .where(eq(schema.oauthRefreshTokens.clientId, clientId))
      await tx
        .delete(schema.oauthAccessTokens)
        .where(eq(schema.oauthAccessTokens.clientId, clientId))
      await tx.delete(schema.oauthConsents).where(eq(schema.oauthConsents.clientId, clientId))
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
    await tx
      .delete(schema.oauthRefreshTokens)
      .where(inArray(schema.oauthRefreshTokens.referenceId, ids))
    await tx
      .delete(schema.oauthAccessTokens)
      .where(inArray(schema.oauthAccessTokens.referenceId, ids))
    await tx.delete(schema.oauthConsents).where(inArray(schema.oauthConsents.referenceId, ids))
  })
}

/** disconnectOAuthApplication revokes every snapshot, pending request and token family for this user and client. */
export async function disconnectOAuthApplication(clientId: string) {
  const session = await getAuthSession()
  if (!session) throw new Error("Sign in to manage connected applications.")
  const userId = session.session.user.id
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
    await tx
      .delete(schema.oauthRefreshTokens)
      .where(
        and(
          eq(schema.oauthRefreshTokens.clientId, clientId),
          eq(schema.oauthRefreshTokens.userId, userId)
        )
      )
    await tx
      .delete(schema.oauthAccessTokens)
      .where(
        and(
          eq(schema.oauthAccessTokens.clientId, clientId),
          eq(schema.oauthAccessTokens.userId, userId)
        )
      )
    await tx
      .delete(schema.oauthConsents)
      .where(
        and(eq(schema.oauthConsents.clientId, clientId), eq(schema.oauthConsents.userId, userId))
      )
  })
}

/** approveDelegation records an immutable selection against one signed authorization request. */
export async function approveDelegation(
  oauthQuery: string,
  organizationId: string | null,
  selection: DelegationCatalog
) {
  const session = await getAuthSession()
  if (!session) throw new Error("Sign in to continue.")
  const user = session.session.user
  const transaction = await delegationTransaction(oauthQuery, user.id, session.session.session.id)
  if (!transaction)
    throw new Error("This authorization request has expired. Start again from the application.")
  const inference = transaction.scopes.includes("inference:use")
  const mcp = transaction.scopes.includes("mcp:use")
  if ((!inference && selection.models.length) || (!mcp && selection.mcp.length))
    throw new Error("The application did not request those resources.")
  if (!inference && !mcp && organizationId)
    throw new Error("Identity access does not require an organization.")
  if (!selection.models.length && !selection.mcp.length) organizationId = null
  if ((selection.models.length || selection.mcp.length) && !organizationId)
    throw new Error("Select an organization.")
  if (organizationId) await checkDelegationSelection(organizationId, selection, user)
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
    if (pending.grantId) {
      const [grant] = await tx
        .select()
        .from(schema.delegationGrants)
        .where(
          and(
            eq(schema.delegationGrants.id, pending.grantId),
            isNull(schema.delegationGrants.revokedAt)
          )
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
    await tx
      .update(schema.delegationTransactions)
      .set({ grantId: id })
      .where(eq(schema.delegationTransactions.id, pending.id))
    return id
  })
  return { grantId }
}
