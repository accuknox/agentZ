import { randomUUID } from "node:crypto"
import { and, arrayContains, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm"
import { defineRequestState, getCurrentAuthEndpointContext } from "@better-auth/core/context"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import {
  getOAuthProviderState,
  getOAuthProviderApi,
  oauthProvider,
  oauthDeviceAuthorization,
  DEVICE_CODE_GRANT_TYPE,
  verifyOAuthQueryParams,
  type OAuthClaimExtensionInput,
  type OAuthAuthorizationQuery,
  type OAuthRefreshToken,
} from "@better-auth/oauth-provider"
import { z } from "zod"
import { delegationScopes } from "@/data/schema"
import { getDB, schema } from "@/db"
import { getEnv } from "@/lib/env"
import { getDelegationCatalog, getWorkspace, type DelegationCatalog } from "@/lib/gateway/client"
import { createClient } from "@/lib/gateway/client/client"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

/** assertOAuthOrigin binds browser requests to the registered public client's origins. */
async function assertOAuthOrigin(origin: string | null, clientId: string) {
  if (origin === null) return
  const [registered] = await getDB()
    .select({ origin: schema.oauthClientOrigins.origin })
    .from(schema.oauthClientOrigins)
    .innerJoin(
      schema.oauthClients,
      eq(schema.oauthClients.clientId, schema.oauthClientOrigins.clientId)
    )
    .where(
      and(
        eq(schema.oauthClientOrigins.clientId, clientId),
        eq(schema.oauthClientOrigins.origin, origin),
        eq(schema.oauthClients.applicationType, "web"),
        eq(schema.oauthClients.tokenEndpointAuthMethod, "none"),
        eq(schema.oauthClients.disabled, false)
      )
    )
    .limit(1)
  if (!registered)
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "This origin is not authorized for this application.",
    })
}

/** delegationCatalog reads current resource permissions without changing the user's active organization. */
export async function delegationCatalog(
  organizationId: string,
  workspaceId: string,
  user: Pick<typeof schema.users.$inferSelect, "id" | "name">,
  includeUnavailable = false
) {
  const { getGatewayAuthToken } = await import("@/lib/gateway/auth")
  const { serverGatewayBaseURL } = await import("@/lib/gateway/server-base-url")
  const token = await getGatewayAuthToken(organizationId, user.id, user.name, workspaceId).catch(
    (error: unknown) => {
      if (error instanceof GatewayUnauthorizedError)
        throw new APIError("FORBIDDEN", {
          error: "access_denied",
          message: "This workspace is no longer available for delegation.",
        })
      throw error
    }
  )
  const result = await getDelegationCatalog({
    client: createClient({ baseUrl: serverGatewayBaseURL(), auth: token }),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    query: { include_unavailable: includeUnavailable },
  })
  if (result.error) {
    if (result.response?.status === 401 || result.response?.status === 403)
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        message: result.error.message,
      })
    throw new Error(result.error.message)
  }
  return result.data
}

/** externalAgentAccess enforces the registration's owner and live workspace permission. */
export async function externalAgentAccess(
  clientId: string,
  user: Pick<typeof schema.users.$inferSelect, "id" | "name">
) {
  const [agent] = await getDB()
    .select()
    .from(schema.externalAgents)
    .where(eq(schema.externalAgents.clientId, clientId))
  if (!agent) return undefined
  if (agent.userId !== user.id)
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      message: "Sign in as this agent's owner.",
    })
  const { getGatewayAuthToken } = await import("@/lib/gateway/auth")
  const { serverGatewayBaseURL } = await import("@/lib/gateway/server-base-url")
  const token = await getGatewayAuthToken(
    agent.organizationId,
    user.id,
    user.name,
    agent.workspaceId
  ).catch((error: unknown) => {
    if (error instanceof GatewayUnauthorizedError)
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        message: "This workspace is no longer available.",
      })
    throw error
  })
  const result = await getWorkspace({
    client: createClient({ baseUrl: serverGatewayBaseURL(), auth: token }),
    path: { workspaceId: agent.workspaceId },
  })
  if (!result.response || result.response.status >= 500)
    throw new Error("Agent access could not be verified. Try again.")
  if (!result.data?.capabilities.external_agents.read || result.data.state !== "ready")
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      message: "Use externally permission is no longer available in this workspace.",
    })
  return agent
}

/** checkDelegationSelection rechecks ownership and permissions, including capability availability for new consent. */
export async function checkDelegationSelection(
  organizationId: string,
  selection: DelegationCatalog,
  user: Pick<typeof schema.users.$inferSelect, "id" | "name">,
  mode: "consent" | "access"
) {
  const approved: DelegationCatalog = { models: [], mcp: [] }
  if (selection.models.length > 256 || selection.mcp.length > 32) {
    throw new Error("Select at most 256 models and 32 MCP connections.")
  }
  if (Buffer.byteLength(JSON.stringify(selection)) > 256 << 10) {
    throw new Error("Choose fewer capabilities. A selection cannot exceed 256 KiB.")
  }
  if (
    selection.mcp.some((connection) =>
      [...connection.tools, ...connection.prompts, ...connection.resources].some(
        (value) => Buffer.byteLength(value) > 2_500
      )
    )
  ) {
    throw new Error("An MCP capability name or URI is too long for the gateway's access policy.")
  }
  if (
    new Set(selection.models.map((model) => model.id)).size !== selection.models.length ||
    new Set(selection.mcp.map((connection) => connection.id)).size !== selection.mcp.length ||
    selection.mcp.some(
      (connection) =>
        !connection.tools.length && !connection.prompts.length && !connection.resources.length
    )
  ) {
    throw new Error("Select each model or MCP connection once, with at least one MCP capability.")
  }
  const [setting] = await getDB()
    .select({ enabled: schema.organizationDelegation.enabled })
    .from(schema.organizationDelegation)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.organizationId, schema.organizationDelegation.organizationId),
        eq(schema.members.userId, user.id),
        isNull(schema.members.disabledAt)
      )
    )
    .where(
      and(
        eq(schema.organizationDelegation.organizationId, organizationId),
        eq(schema.organizationDelegation.enabled, true)
      )
    )
  if (!setting)
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      message: "Resource delegation is unavailable for this organization.",
    })
  const workspaceIds = new Set(
    [...selection.models, ...selection.mcp].map((item) => item.workspace_id)
  )
  for (const workspaceId of workspaceIds) {
    const catalog = await delegationCatalog(organizationId, workspaceId, user, mode === "access")
    for (const [index, model] of selection.models.entries()) {
      if (model.workspace_id !== workspaceId) continue
      const current = catalog.models.find((item) => item.id === model.id)
      if (
        !current ||
        current.uid !== model.uid ||
        current.model !== model.model ||
        current.namespace !== model.namespace ||
        current.provider !== model.provider
      ) {
        throw new APIError("FORBIDDEN", {
          error: "access_denied",
          message: "A selected model is no longer available for delegation.",
        })
      }
      approved.models[index] = current
    }
    for (const [index, connection] of selection.mcp.entries()) {
      if (connection.workspace_id !== workspaceId) continue
      const current = catalog.mcp.find((item) => item.id === connection.id)
      if (
        !current ||
        current.uid !== connection.uid ||
        current.namespace !== connection.namespace ||
        current.connection !== connection.connection ||
        (mode === "consent" &&
          (!connection.tools.every((name) => current.tools.includes(name)) ||
            !connection.prompts.every((name) => current.prompts.includes(name)) ||
            !connection.resources.every((uri) => current.resources.includes(uri))))
      ) {
        throw new APIError("FORBIDDEN", {
          error: "access_denied",
          message: "A selected MCP capability is no longer available for delegation.",
        })
      }
      approved.mcp[index] = {
        ...current,
        tools: connection.tools,
        prompts: connection.prompts,
        resources: connection.resources,
      }
    }
  }
  return approved
}

/** delegationTransaction verifies the provider's signed query before loading its server-owned transaction. */
async function delegationTransaction(oauthQuery: string, userId: string, sessionId: string) {
  if (!(await verifyOAuthQueryParams(oauthQuery, getEnv().BETTER_AUTH_SECRET))) {
    throw new Error("This authorization request is invalid or has expired.")
  }
  const params = new URLSearchParams(oauthQuery)
  if (params.has("claims"))
    throw new Error("Request profile or email scopes instead of explicit claims.")
  const id = params.get("agentz_tx")
  if (!id) throw new Error("Authorization selection has not started.")
  const [transaction] = await getDB()
    .select()
    .from(schema.delegationTransactions)
    .where(
      and(
        eq(schema.delegationTransactions.id, id),
        eq(schema.delegationTransactions.userId, userId),
        eq(schema.delegationTransactions.sessionId, sessionId),
        eq(schema.delegationTransactions.clientId, params.get("client_id") ?? ""),
        gt(schema.delegationTransactions.expiresAt, new Date())
      )
    )
  if (!transaction) return undefined
  const original = new URLSearchParams(transaction.authorizationQuery)
  for (const key of [
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "nonce",
    "state",
    "scope",
    "resource",
    "response_type",
    "claims",
  ]) {
    if (JSON.stringify(original.getAll(key)) !== JSON.stringify(params.getAll(key))) {
      throw new Error("The authorization request changed. Start again from the application.")
    }
  }
  return transaction
}

const consentRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authorization_code"), oauthQuery: z.string().min(1) }),
  z.object({ type: z.literal("device_code"), userCode: z.string().min(1).max(191) }),
])

/** DelegationRequest identifies a server-owned consent request by its native protocol. */
export type DelegationRequest = z.infer<typeof consentRequest>

/** delegationRequest checks consent ownership before reading either OAuth flow. */
export async function delegationRequest(
  request: DelegationRequest,
  userId: string,
  sessionId: string
) {
  request = consentRequest.parse(request)
  if (request.type === "authorization_code") {
    const transaction = await delegationTransaction(request.oauthQuery, userId, sessionId)
    if (!transaction)
      throw new Error("This authorization request expired. Start again from the application.")
    return { ...transaction, type: request.type }
  }
  const { getAuth } = await import("@/lib/auth")
  const { headers } = await import("next/headers")
  const verified = await getAuth().api.deviceVerify({
    query: { user_code: request.userCode },
    headers: await headers(),
  })
  const [device] = await getDB()
    .select()
    .from(schema.deviceCodes)
    .where(
      and(
        eq(schema.deviceCodes.userCode, verified.user_code),
        eq(schema.deviceCodes.userId, userId),
        eq(schema.deviceCodes.status, "pending"),
        gt(schema.deviceCodes.expiresAt, new Date())
      )
    )
  if (!device?.oauthClientId)
    throw new Error("This device request expired or belongs to another account.")
  return {
    ...device,
    type: request.type,
    clientId: device.oauthClientId,
    scopes: device.scope?.split(/\s+/).filter(Boolean) ?? [],
    resources: device.resources ?? [],
    grantId: device.referenceId,
  }
}

/** approvedDelegation loads a live snapshot bound to its user and enabled application's scope ceiling. */
async function approvedDelegation(clientId: string, userId: string, grantId?: string) {
  const [current] = await getDB()
    .select({ grant: schema.delegationGrants, user: schema.users })
    .from(schema.delegationGrants)
    .innerJoin(schema.users, eq(schema.users.id, schema.delegationGrants.userId))
    .innerJoin(
      schema.oauthClients,
      eq(schema.oauthClients.clientId, schema.delegationGrants.clientId)
    )
    .where(
      and(
        grantId === undefined ? undefined : eq(schema.delegationGrants.id, grantId),
        eq(schema.delegationGrants.clientId, clientId),
        eq(schema.delegationGrants.userId, userId),
        eq(schema.oauthClients.disabled, false),
        arrayContains(schema.oauthClients.scopes, schema.delegationGrants.scopes),
        isNull(schema.delegationGrants.revokedAt),
        isNotNull(schema.delegationGrants.approvedAt)
      )
    )
    .orderBy(desc(schema.delegationGrants.createdAt))
    .limit(1)
  return current
}

/** agentZOAuthProvider uses native OAuth flows with immutable AgentZ resource grants. */
export function agentZOAuthProvider(issuer: string) {
  const refreshTokenHash = defineRequestState(() => "")
  const tokenSelection = defineRequestState<DelegationCatalog | undefined>(() => undefined)
  const inferenceResource = `${issuer}/api/inference/v1`
  const mcpResource = `${issuer}/api/mcp`
  const delegationTokenClaims = async ({
    user,
    client,
    referenceId,
    scopes,
    resources,
  }: Pick<OAuthClaimExtensionInput, "user" | "referenceId" | "scopes" | "resources"> & {
    client: Pick<OAuthClaimExtensionInput["client"], "clientId">
  }) => {
    const current = await approvedDelegation(client.clientId, user?.id ?? "", referenceId ?? "")
    const grant = current?.grant
    if (
      !grant ||
      !user ||
      !scopes.every((scope) => grant.scopes.includes(scope)) ||
      !(resources ?? []).every((resource) => grant.resources.includes(resource))
    ) {
      throw new APIError("BAD_REQUEST", { error: "invalid_grant" })
    }
    let selection = grant.selection
    try {
      await externalAgentAccess(client.clientId, user)
      if (grant.organizationId) {
        selection = await checkDelegationSelection(
          grant.organizationId,
          grant.selection,
          user,
          "access"
        )
      }
    } catch (error) {
      if (error instanceof APIError && error.body?.error === "access_denied")
        throw new APIError("BAD_REQUEST", { error: "invalid_grant" })
      throw error
    }
    await tokenSelection.set({
      models: scopes.includes("inference:use") ? selection.models : [],
      mcp: [],
    })
    return { agentz_grant_id: grant.id }
  }
  const provider = oauthProvider({
    loginPage: "/signin",
    consentPage: "/oauth/authorize",
    scopes: delegationScopes,
    grantTypes: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE],
    accessTokenExpiresIn: 300,
    refreshTokenExpiresIn: 30 * 24 * 60 * 60,
    rateLimit: { token: { window: 60, max: 600 } },
    allowDynamicClientRegistration: false,
    allowPublicWebHttpLoopbackRedirects: process.env.NODE_ENV === "development",
    clientRegistrationAllowedScopes: delegationScopes,
    resources: [
      { identifier: inferenceResource, allowedScopes: delegationScopes, accessTokenTtl: 300 },
      { identifier: mcpResource, allowedScopes: delegationScopes, accessTokenTtl: 300 },
    ],
    resourceSeedMode: "overwrite",
    clientRegistrationDefaultResources: [inferenceResource, mcpResource],
    resourcePrivileges: () => false,
    customTokenResponseFields: async ({ grantType, verificationValue, user, scopes }) => {
      // Opaque OAuth grants without openid do not run either JWT claim hook.
      if (verificationValue && !verificationValue.resource?.length) {
        await delegationTokenClaims({
          user,
          client: { clientId: verificationValue.query.client_id },
          referenceId: verificationValue.referenceId,
          scopes,
        })
      }
      if (grantType === "refresh_token") {
        const token = await refreshTokenHash.get()
        const [refresh] = await getDB()
          .select()
          .from(schema.oauthRefreshTokens)
          .where(eq(schema.oauthRefreshTokens.token, token))
        if (!refresh) throw new APIError("BAD_REQUEST", { error: "invalid_grant" })
        if (!refresh.resources?.length)
          await delegationTokenClaims({
            user,
            client: { clientId: refresh.clientId },
            referenceId: refresh.referenceId ?? undefined,
            scopes,
          })
      }
      const selection = await tokenSelection.get()
      return selection ? { agentz_grant: selection } : {}
    },
    clientReference: ({ session }) =>
      z.string().nullish().parse(session?.activeOrganizationId) ?? undefined,
    clientPrivileges: async ({ user, session, action, headers }) => {
      const { isActiveSuperadmin } = await import("@/data/organizations")
      const organizationId = z.string().nullish().parse(session?.activeOrganizationId)
      const workspaceId = headers.get("X-AgentZ-Workspace-ID")
      // Registration endpoints are server-only or disabled. The onboarding
      // action supplies fixed native metadata; workspace authority is still live.
      if (action === "create" && user && organizationId && workspaceId) {
        const { getGatewayAuthToken } = await import("@/lib/gateway/auth")
        const { serverGatewayBaseURL } = await import("@/lib/gateway/server-base-url")
        const token = await getGatewayAuthToken(organizationId, user.id, user.name, workspaceId)
        const result = await getWorkspace({
          client: createClient({ baseUrl: serverGatewayBaseURL(), auth: token }),
          path: { workspaceId },
        })
        return !!result.data?.capabilities.external_agents.create
      }
      return (
        action !== "configure-client-credentials-scopes" &&
        !!user &&
        !!organizationId &&
        (await isActiveSuperadmin(getDB(), organizationId, user.id))
      )
    },
    postLogin: {
      page: "/oauth/authorize",
      shouldRedirect: async ({ user, session, scopes }) => {
        const ctx = getCurrentAuthEndpointContext()
        const state = await getOAuthProviderState()
        const params = new URLSearchParams(state?.query)
        const existingId = params.get("agentz_tx")
        if (existingId) {
          const signedQuery = z.string().parse(ctx.body?.oauth_query)
          const transaction = await delegationTransaction(signedQuery, user.id, session.id)
          if (!transaction) throw new APIError("FORBIDDEN", { error: "access_denied" })
          if (!transaction.grantId) return true
          const current = await approvedDelegation(
            transaction.clientId,
            user.id,
            transaction.grantId
          )
          const grant = current?.grant
          if (!grant) throw new APIError("FORBIDDEN", { error: "access_denied" })
          if (grant.organizationId)
            await checkDelegationSelection(grant.organizationId, grant.selection, user, "access")
          return false
        }

        // Better Auth has validated this query and applied the client's defaults.
        const query: OAuthAuthorizationQuery = ctx.query
        const authorizationQuery = new URLSearchParams()
        for (const [key, values] of Object.entries(query)) {
          if (values === undefined) continue
          for (const value of [values].flat()) {
            authorizationQuery.append(
              key,
              key === "claims" ? JSON.stringify(value) : value.toString()
            )
          }
        }
        const resources = query.resource ? [query.resource].flat() : []
        if (
          (scopes.includes("inference:use") && !resources.includes(inferenceResource)) ||
          (scopes.includes("mcp:use") && !resources.includes(mcpResource))
        ) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_target",
            error_description: "Request the gateway resource with its use scope.",
          })
        }
        const current = await approvedDelegation(query.client_id, user.id)
        const previous = current?.grant
        let reusable = previous
        if (
          params.get("prompt")?.split(" ").includes("consent") ||
          !previous ||
          !scopes.every((scope) => previous.scopes.includes(scope)) ||
          !resources.every((resource) => previous.resources.includes(resource))
        )
          reusable = undefined
        if (reusable?.organizationId) {
          try {
            await checkDelegationSelection(
              reusable.organizationId,
              reusable.selection,
              user,
              "access"
            )
          } catch {
            reusable = undefined
          }
        }
        const id = randomUUID()
        await getDB()
          .insert(schema.delegationTransactions)
          .values({
            id,
            clientId: query.client_id,
            userId: user.id,
            sessionId: session.id,
            authorizationQuery: authorizationQuery.toString(),
            scopes,
            resources,
            grantId: reusable?.id ?? null,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          })
        ctx.query = { ...ctx.query, agentz_tx: id }
        return !reusable
      },
      consentReferenceId: async ({ user, session, scopes }) => {
        const ctx = getCurrentAuthEndpointContext()
        const state = await getOAuthProviderState()
        const params = new URLSearchParams(state?.query)
        if (params.has("claims"))
          throw new Error("Request profile or email scopes instead of explicit claims.")
        const id = params.get("agentz_tx") ?? z.string().optional().parse(ctx.query?.agentz_tx)
        if (!id) throw new APIError("BAD_REQUEST", { error: "invalid_request" })
        if (
          ctx.body?.oauth_query &&
          new URLSearchParams(z.string().parse(ctx.body.oauth_query)).has("agentz_tx")
        ) {
          const transaction = await delegationTransaction(
            z.string().parse(ctx.body.oauth_query),
            user.id,
            session.id
          )
          if (!transaction) throw new APIError("FORBIDDEN", { error: "access_denied" })
        }
        const [transaction] = await getDB()
          .select()
          .from(schema.delegationTransactions)
          .where(
            and(
              eq(schema.delegationTransactions.id, id),
              eq(schema.delegationTransactions.userId, user.id),
              eq(schema.delegationTransactions.sessionId, session.id),
              eq(schema.delegationTransactions.clientId, params.get("client_id") ?? ""),
              gt(schema.delegationTransactions.expiresAt, new Date())
            )
          )
        if (!transaction?.grantId) throw new APIError("FORBIDDEN", { error: "access_denied" })
        const current = await approvedDelegation(transaction.clientId, user.id, transaction.grantId)
        const grant = current?.grant
        if (
          !grant ||
          !scopes.every((scope) => grant.scopes.includes(scope)) ||
          !params.getAll("resource").every((resource) => grant.resources.includes(resource))
        ) {
          throw new APIError("FORBIDDEN", { error: "access_denied" })
        }
        if (grant.organizationId)
          await checkDelegationSelection(grant.organizationId, grant.selection, user, "access")
        return grant.id
      },
    },
    extensions: [
      {
        claims: {
          accessToken: delegationTokenClaims,
          idToken: delegationTokenClaims,
          userInfo: async ({ ctx, jwt, user }) => {
            const grantId = z.string().parse(jwt.agentz_grant_id)
            const clientId = z.string().parse(jwt.client_id)
            await assertOAuthOrigin(ctx.headers?.get("origin") ?? null, clientId)
            const current = await approvedDelegation(clientId, user.id, grantId)
            const grant = current?.grant
            if (!grant) throw new APIError("UNAUTHORIZED", { error: "invalid_token" })
            if (grant.organizationId) {
              try {
                await checkDelegationSelection(
                  grant.organizationId,
                  grant.selection,
                  user,
                  "access"
                )
              } catch (error) {
                if (error instanceof APIError && error.body?.error === "access_denied")
                  throw new APIError("UNAUTHORIZED", { error: "invalid_token" })
                throw error
              }
            }
            return {}
          },
        },
      },
    ],
  })
  return {
    ...provider,
    hooks: {
      ...provider.hooks,
      before: [
        ...provider.hooks.before,
        {
          matcher: (ctx) => ctx.path === "/oauth2/token" || ctx.path === "/oauth2/revoke",
          handler: createAuthMiddleware(async (ctx) => {
            const api = getOAuthProviderApi(ctx, provider.options)
            const { clientId } = await api.authenticateClient({
              requireCredentials: false,
            })
            await assertOAuthOrigin(ctx.headers?.get("origin") ?? null, clientId)
            if (ctx.path === "/oauth2/revoke") {
              const request = provider.endpoints.oauth2Revoke.options.body.safeParse(ctx.body)
              if (!request.success) return undefined
              // Revocation accepts the token itself, without an Authorization scheme.
              if (/\s/.test(request.data.token)) return ctx.json(null)
              const token = await api.hashToken(request.data.token, "refresh_token")
              const refresh = await ctx.context.adapter.findOne<OAuthRefreshToken>({
                model: "oauthRefreshToken",
                where: [{ field: "token", value: token }],
              })
              // The provider invalidates a revoked token's family before checking its owner.
              if (refresh && refresh.clientId !== clientId) return ctx.json(null)
              return undefined
            }
            const request = provider.endpoints.oauth2Token.options.body.safeParse(ctx.body)
            if (
              !request.success ||
              request.data.grant_type !== "refresh_token" ||
              !request.data.refresh_token
            )
              return undefined
            const token = await api.hashToken(request.data.refresh_token, "refresh_token")
            await refreshTokenHash.set(token)
            // Expired browser sessions must not bind newly issued offline tokens.
            // The provider still authenticates the client and validates the refresh.
            await getDB()
              .update(schema.oauthRefreshTokens)
              .set({ sessionId: null })
              .where(
                and(
                  eq(schema.oauthRefreshTokens.token, token),
                  eq(schema.oauthRefreshTokens.clientId, clientId),
                  arrayContains(schema.oauthRefreshTokens.scopes, ["offline_access"]),
                  inArray(
                    schema.oauthRefreshTokens.sessionId,
                    getDB()
                      .select({ id: schema.sessions.id })
                      .from(schema.sessions)
                      .where(lte(schema.sessions.expiresAt, new Date()))
                  )
                )
              )
            return undefined
          }),
        },
      ],
      after: [
        ...provider.hooks.after,
        {
          matcher: (ctx) => ctx.path === "/oauth2/introspect",
          handler: createAuthMiddleware(async (ctx) => {
            // Native introspection skips claim extensions; check the live grant too.
            const result = z
              .object({
                active: z.boolean(),
                agentz_grant_id: z.string().optional(),
                client_id: z.string().optional(),
                sub: z.string().optional(),
                scope: z.string().optional(),
              })
              .safeParse(ctx.context.returned)
            if (!result.success || !result.data.active) return undefined
            const payload = result.data
            let grantId = payload.agentz_grant_id
            if (!grantId) {
              const token = z.string().parse(ctx.body?.token)
              const hash = await getOAuthProviderApi(ctx, provider.options).hashToken(
                token,
                "refresh_token"
              )
              const [refresh] = await getDB()
                .select({ referenceId: schema.oauthRefreshTokens.referenceId })
                .from(schema.oauthRefreshTokens)
                .where(eq(schema.oauthRefreshTokens.token, hash))
              grantId = refresh?.referenceId ?? undefined
            }
            const current = await approvedDelegation(
              payload.client_id ?? "",
              payload.sub ?? "",
              grantId ?? ""
            )
            if (
              !current ||
              !payload.scope?.split(" ").every((scope) => current.grant.scopes.includes(scope))
            )
              return ctx.json({ active: false })
            if (current.grant.organizationId) {
              try {
                await checkDelegationSelection(
                  current.grant.organizationId,
                  current.grant.selection,
                  current.user,
                  "access"
                )
              } catch {
                return ctx.json({ active: false })
              }
            }
            return undefined
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}

/** agentZDeviceAuthorization adds server-owned grant bindings to native device authorization. */
export function agentZDeviceAuthorization() {
  const plugin = oauthDeviceAuthorization({
    verificationUri: "/oauth/authorize",
    expiresIn: "10m",
    interval: "5s",
  })
  return {
    ...plugin,
    schema: {
      ...plugin.schema,
      deviceCode: {
        ...plugin.schema.deviceCode,
        fields: {
          ...plugin.schema.deviceCode.fields,
          referenceId: { type: "string", required: false, input: false, returned: false },
          sessionId: { type: "string", required: false, input: false, returned: false },
        },
      },
    },
  } satisfies BetterAuthPlugin
}
