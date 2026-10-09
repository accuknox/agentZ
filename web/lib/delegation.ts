import { randomUUID } from "node:crypto"
import { and, arrayContains, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm"
import { defineRequestState, getCurrentAuthEndpointContext } from "@better-auth/core/context"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import {
  getOAuthProviderState,
  getOAuthProviderApi,
  oauthProvider,
  verifyOAuthQueryParams,
  type OAuthClaimExtensionInput,
  type OAuthRefreshToken,
} from "@better-auth/oauth-provider"
import { z } from "zod"
import { delegationScopes } from "@/data/schema"
import { getDB, schema } from "@/db"
import { getEnv } from "@/lib/env"
import { getDelegationCatalog, type DelegationCatalog } from "@/lib/gateway/client"
import { createClient, createConfig } from "@/lib/gateway/client/client"
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
  user: { id: string; name: string },
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
    client: createClient(createConfig({ baseUrl: serverGatewayBaseURL(), auth: token })),
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

/** checkDelegationSelection rechecks ownership and permissions, including capability availability for new consent. */
export async function checkDelegationSelection(
  organizationId: string,
  selection: DelegationCatalog,
  user: { id: string; name: string },
  includeUnavailable = false
) {
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
    const catalog = await delegationCatalog(organizationId, workspaceId, user, includeUnavailable)
    for (const model of selection.models.filter((item) => item.workspace_id === workspaceId)) {
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
    }
    for (const connection of selection.mcp.filter((item) => item.workspace_id === workspaceId)) {
      const current = catalog.mcp.find((item) => item.id === connection.id)
      if (
        !current ||
        current.uid !== connection.uid ||
        current.namespace !== connection.namespace ||
        current.connection !== connection.connection ||
        (!includeUnavailable &&
          (!connection.tools.every((name) => current.tools.includes(name)) ||
            !connection.prompts.every((name) => current.prompts.includes(name)) ||
            !connection.resources.every((uri) => current.resources.includes(uri))))
      ) {
        throw new APIError("FORBIDDEN", {
          error: "access_denied",
          message: "A selected MCP capability is no longer available for delegation.",
        })
      }
    }
  }
}

/** delegationTransaction verifies the provider's signed query before loading its server-owned transaction. */
export async function delegationTransaction(oauthQuery: string, userId: string, sessionId: string) {
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

/** agentZOAuthProvider uses native OAuth flows with immutable AgentZ resource grants. */
export function agentZOAuthProvider(issuer: string) {
  const refreshTokenHash = defineRequestState(() => "")
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
    const [current] = await getDB()
      .select({ grant: schema.delegationGrants })
      .from(schema.delegationGrants)
      .innerJoin(
        schema.oauthClients,
        eq(schema.oauthClients.clientId, schema.delegationGrants.clientId)
      )
      .where(
        and(
          eq(schema.delegationGrants.id, referenceId ?? ""),
          eq(schema.delegationGrants.clientId, client.clientId),
          eq(schema.delegationGrants.userId, user?.id ?? ""),
          eq(schema.oauthClients.disabled, false),
          arrayContains(schema.oauthClients.scopes, schema.delegationGrants.scopes),
          isNull(schema.delegationGrants.revokedAt),
          isNotNull(schema.delegationGrants.approvedAt)
        )
      )
    const grant = current?.grant
    if (
      !grant ||
      !user ||
      !scopes.every((scope) => grant.scopes.includes(scope)) ||
      !(resources ?? []).every((resource) => grant.resources.includes(resource))
    ) {
      throw new APIError("BAD_REQUEST", { error: "invalid_grant" })
    }
    if (grant.organizationId) {
      try {
        await checkDelegationSelection(grant.organizationId, grant.selection, user, true)
      } catch (error) {
        if (error instanceof APIError && error.body?.error === "access_denied")
          throw new APIError("BAD_REQUEST", { error: "invalid_grant" })
        throw error
      }
    }
    return { agentz_grant_id: grant.id }
  }
  const provider = oauthProvider({
    loginPage: "/oauth/authorize",
    consentPage: "/oauth/authorize",
    scopes: delegationScopes,
    grantTypes: ["authorization_code", "refresh_token"],
    accessTokenExpiresIn: 300,
    refreshTokenExpiresIn: 30 * 24 * 60 * 60,
    allowDynamicClientRegistration: false,
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
      if (scopes.includes("openid")) return {}
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
      return {}
    },
    clientReference: ({ session }) =>
      z.string().nullish().parse(session?.activeOrganizationId) ?? undefined,
    clientPrivileges: async ({ user, session, action }) => {
      const { isActiveSuperadmin } = await import("@/data/organizations")
      const organizationId = z.string().nullish().parse(session?.activeOrganizationId)
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
          const [grant] = await getDB()
            .select()
            .from(schema.delegationGrants)
            .where(
              and(
                eq(schema.delegationGrants.id, transaction.grantId),
                eq(schema.delegationGrants.clientId, transaction.clientId),
                eq(schema.delegationGrants.userId, user.id),
                isNull(schema.delegationGrants.revokedAt),
                isNotNull(schema.delegationGrants.approvedAt)
              )
            )
          if (!grant) throw new APIError("FORBIDDEN", { error: "access_denied" })
          if (grant.organizationId)
            await checkDelegationSelection(grant.organizationId, grant.selection, user, true)
          return false
        }

        const query = z
          .object({
            client_id: z.string(),
            resource: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .parse(ctx.query)
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
        const [previous] = await getDB()
          .select()
          .from(schema.delegationGrants)
          .where(
            and(
              eq(schema.delegationGrants.clientId, query.client_id),
              eq(schema.delegationGrants.userId, user.id),
              isNull(schema.delegationGrants.revokedAt),
              isNotNull(schema.delegationGrants.approvedAt)
            )
          )
          .orderBy(desc(schema.delegationGrants.createdAt))
          .limit(1)
        let reusable =
          !params.get("prompt")?.split(" ").includes("consent") &&
          previous &&
          scopes.every((scope) => previous.scopes.includes(scope)) &&
          resources.every((resource) => previous.resources.includes(resource))
            ? previous
            : undefined
        if (reusable?.organizationId) {
          try {
            await checkDelegationSelection(reusable.organizationId, reusable.selection, user, true)
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
            authorizationQuery: state?.query ?? "",
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
        const [grant] = await getDB()
          .select()
          .from(schema.delegationGrants)
          .where(
            and(
              eq(schema.delegationGrants.id, transaction.grantId),
              eq(schema.delegationGrants.clientId, transaction.clientId),
              eq(schema.delegationGrants.userId, user.id),
              isNull(schema.delegationGrants.revokedAt),
              isNotNull(schema.delegationGrants.approvedAt)
            )
          )
        if (
          !grant ||
          !scopes.every((scope) => grant.scopes.includes(scope)) ||
          !params.getAll("resource").every((resource) => grant.resources.includes(resource))
        ) {
          throw new APIError("FORBIDDEN", { error: "access_denied" })
        }
        if (grant.organizationId)
          await checkDelegationSelection(grant.organizationId, grant.selection, user, true)
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
            const [grant] = await getDB()
              .select({
                organizationId: schema.delegationGrants.organizationId,
                selection: schema.delegationGrants.selection,
              })
              .from(schema.delegationGrants)
              .innerJoin(
                schema.oauthClients,
                eq(schema.oauthClients.clientId, schema.delegationGrants.clientId)
              )
              .where(
                and(
                  eq(schema.delegationGrants.id, grantId),
                  eq(schema.delegationGrants.userId, user.id),
                  eq(schema.delegationGrants.clientId, clientId),
                  eq(schema.oauthClients.disabled, false),
                  arrayContains(schema.oauthClients.scopes, schema.delegationGrants.scopes),
                  isNotNull(schema.delegationGrants.approvedAt),
                  isNull(schema.delegationGrants.revokedAt)
                )
              )
            if (!grant) throw new APIError("UNAUTHORIZED", { error: "invalid_token" })
            if (grant.organizationId) {
              try {
                await checkDelegationSelection(grant.organizationId, grant.selection, user, true)
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
                  eq(schema.delegationGrants.id, grantId ?? ""),
                  eq(schema.delegationGrants.clientId, payload.client_id ?? ""),
                  eq(schema.delegationGrants.userId, payload.sub ?? ""),
                  eq(schema.oauthClients.disabled, false),
                  arrayContains(schema.oauthClients.scopes, schema.delegationGrants.scopes),
                  isNotNull(schema.delegationGrants.approvedAt),
                  isNull(schema.delegationGrants.revokedAt)
                )
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
                  true
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
