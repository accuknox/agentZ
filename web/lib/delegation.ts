import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm"
import { getCurrentAuthEndpointContext } from "@better-auth/core/context"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import {
  getOAuthProviderState,
  getOAuthProviderApi,
  oauthProvider,
  verifyOAuthQueryParams,
  type OAuthClaimExtensionInput,
} from "@better-auth/oauth-provider"
import { z } from "zod"
import { getDB, schema } from "@/db"
import { getEnv } from "@/lib/env"
import { getDelegationCatalog, type DelegationCatalog } from "@/lib/gateway/client"
import { createClient, createConfig } from "@/lib/gateway/client/client"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

export const delegationScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "inference:use",
  "mcp:use",
]

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
export function agentZOAuthProvider() {
  const env = getEnv()
  const inferenceResource = `${env.BETTER_AUTH_URL}/api/inference/v1`
  const mcpResource = `${env.BETTER_AUTH_URL}/api/mcp`
  const delegationTokenClaims = async ({
    user,
    client,
    referenceId,
    scopes,
    resources,
  }: Pick<OAuthClaimExtensionInput, "user" | "referenceId" | "scopes" | "resources"> & {
    client: Pick<OAuthClaimExtensionInput["client"], "clientId">
  }) => {
    const [grant] = await getDB()
      .select()
      .from(schema.delegationGrants)
      .where(
        and(
          eq(schema.delegationGrants.id, referenceId ?? ""),
          eq(schema.delegationGrants.clientId, client.clientId),
          eq(schema.delegationGrants.userId, user?.id ?? ""),
          isNull(schema.delegationGrants.revokedAt),
          isNotNull(schema.delegationGrants.approvedAt)
        )
      )
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
    customTokenResponseFields: async ({ verificationValue, user, scopes }) => {
      // Opaque OAuth grants without openid do not run either JWT claim hook.
      if (verificationValue && !scopes.includes("openid") && !verificationValue.resource?.length) {
        await delegationTokenClaims({
          user,
          client: { clientId: verificationValue.query.client_id },
          referenceId: verificationValue.referenceId,
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
          userInfo: async ({ jwt, user }) => {
            const grantId = z.string().parse(jwt.agentz_grant_id)
            const clientId = z.string().parse(jwt.client_id)
            const [grant] = await getDB()
              .select()
              .from(schema.delegationGrants)
              .where(
                and(
                  eq(schema.delegationGrants.id, grantId),
                  eq(schema.delegationGrants.userId, user.id),
                  eq(schema.delegationGrants.clientId, clientId),
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
  // Native JWT/refresh introspection validates the token, but does not run
  // claim extensions. Its answer must also reflect the live AgentZ grant.
  return {
    ...provider,
    hooks: {
      ...provider.hooks,
      after: [
        ...provider.hooks.after,
        {
          matcher: (ctx) => ctx.path === "/oauth2/introspect",
          handler: createAuthMiddleware(async (ctx) => {
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
              .where(
                and(
                  eq(schema.delegationGrants.id, grantId ?? ""),
                  eq(schema.delegationGrants.clientId, payload.client_id ?? ""),
                  eq(schema.delegationGrants.userId, payload.sub ?? ""),
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
