import "server-only"

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { headers } from "next/headers"
import { and, eq, gt } from "drizzle-orm"
import { RequestError } from "@octokit/request-error"
import { Octokit } from "@octokit/rest"
import { deleteAuthorization, refreshToken } from "@octokit/oauth-methods"
import { z } from "zod"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { getDB, schema } from "@/db"

// No caller supplies an actor ID. Roles, API keys and resource ownership cannot
// select a connection. Better Auth has no administrator impersonation plugin.
export async function githubActor() {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  })
  if (!session) throw new Error("Sign in to use GitHub")
  return session
}

function githubApp() {
  const env = getEnv()
  if (
    !env.CODING_GITHUB_CLIENT_ID ||
    !env.CODING_GITHUB_CLIENT_SECRET ||
    !env.CODING_GITHUB_ENCRYPTION_KEY
  ) {
    throw new Error("The Coding GitHub App is not configured")
  }
  return {
    clientType: "github-app" as const,
    clientId: env.CODING_GITHUB_CLIENT_ID,
    clientSecret: env.CODING_GITHUB_CLIENT_SECRET,
    key: Buffer.from(env.CODING_GITHUB_ENCRYPTION_KEY, "hex"),
  }
}

function sealToken(token: string, userId: string, githubUserId: number) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", githubApp().key, nonce)
  cipher.setAAD(Buffer.from(`agentz:github:${userId}:${githubUserId}`))
  return Buffer.concat([
    nonce,
    cipher.update(token, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64")
}

function openToken(token: string, userId: string, githubUserId: number) {
  const bytes = Buffer.from(token, "base64")
  const cipher = createDecipheriv("aes-256-gcm", githubApp().key, bytes.subarray(0, 12))
  cipher.setAAD(Buffer.from(`agentz:github:${userId}:${githubUserId}`))
  cipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8")
}

export async function beginGitHubConnection() {
  const actor = await githubActor()
  const app = githubApp()
  const state = randomBytes(32).toString("base64url")
  const verifier = randomBytes(32).toString("base64url")
  await getDB()
    .insert(schema.githubAuthorizations)
    .values({
      state,
      verifier,
      userId: actor.user.id,
      sessionId: actor.session.id,
      expiresAt: new Date(Date.now() + 600_000),
    })
  const url = new URL("https://github.com/login/oauth/authorize")
  url.search = new URLSearchParams({
    client_id: app.clientId,
    state,
    redirect_uri: new URL("/api/github/callback", getEnv().BETTER_AUTH_URL).href,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString()
  return url.href
}

// The library's code exchange does not support PKCE yet. Validate GitHub's wire
// response here; the rest of this module uses typed Octokit endpoints.
const exchangeResponse = z.object({
  access_token: z.string().startsWith("ghu_"),
  refresh_token: z.string().startsWith("ghr_"),
  expires_in: z.number().int().positive(),
  refresh_token_expires_in: z.number().int().positive(),
  token_type: z.literal("bearer"),
})

export async function finishGitHubConnection(code: string, state: string) {
  const actor = await githubActor()
  const [authorization] = await getDB()
    .delete(schema.githubAuthorizations)
    .where(
      and(
        eq(schema.githubAuthorizations.state, state),
        eq(schema.githubAuthorizations.userId, actor.user.id),
        eq(schema.githubAuthorizations.sessionId, actor.session.id),
        gt(schema.githubAuthorizations.expiresAt, new Date())
      )
    )
    .returning()
  if (!authorization) throw new Error("GitHub authorization expired or belongs to another session")
  const app = githubApp()
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      code_verifier: authorization.verifier,
      redirect_uri: new URL("/api/github/callback", getEnv().BETTER_AUTH_URL).href,
    }),
  })
  const parsed = exchangeResponse.safeParse(await response.json())
  if (!response.ok || !parsed.success)
    throw new Error(
      "GitHub authorization failed. Enable expiring user access tokens for the GitHub App."
    )
  const tokens = parsed.data
  const octokit = new Octokit({ auth: tokens.access_token, request: { timeout: 30_000 } })
  const { data: user } = await octokit.users.getAuthenticated()
  const identity = {
    userId: actor.user.id,
    githubUserId: user.id,
    login: user.login,
    name: user.name || user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
    accessToken: sealToken(tokens.access_token, actor.user.id, user.id),
    refreshToken: sealToken(tokens.refresh_token, actor.user.id, user.id),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    refreshExpiresAt: new Date(Date.now() + tokens.refresh_token_expires_in * 1000),
  }
  await getDB().transaction(async (tx) => {
    // Serialize callbacks with token use and disconnect on the same user row.
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, actor.user.id))
      .for("update")
    const [existing] = await tx
      .select()
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.userId, actor.user.id))
    if (existing && existing.githubUserId !== user.id)
      throw new Error("Disconnect your current GitHub account before connecting another")
    await tx
      .insert(schema.githubConnections)
      .values(identity)
      .onConflictDoUpdate({ target: schema.githubConnections.userId, set: identity })
  })
}

// Refresh and disconnect serialize on the actor row. The operation starts only
// after refreshed credentials have committed, so failures cannot undo rotation.
// Never return this context from a server action or place it in an agent request.
export async function withGitHub<T>(
  action: (context: {
    octokit: Octokit
    token: string
    login: string
    name: string
    email: string
  }) => Promise<T>
): Promise<T> {
  const actor = await githubActor()
  return getDB()
    .transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, actor.user.id))
        .for("update")
      const [connection] = await tx
        .select()
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.userId, actor.user.id))
      if (!connection) throw new Error("Connect your GitHub account in account settings")
      let token = openToken(connection.accessToken, actor.user.id, connection.githubUserId)
      if (connection.expiresAt.getTime() < Date.now() + 60_000) {
        if (connection.refreshExpiresAt.getTime() <= Date.now())
          throw new Error("Reconnect your GitHub account")
        let refreshed: Awaited<ReturnType<typeof refreshToken>>
        try {
          refreshed = await refreshToken({
            ...githubApp(),
            refreshToken: openToken(
              connection.refreshToken,
              actor.user.id,
              connection.githubUserId
            ),
          })
        } catch {
          throw new Error("GitHub authorization expired. Reconnect your account.")
        }
        token = refreshed.authentication.token
        await tx
          .update(schema.githubConnections)
          .set({
            accessToken: sealToken(token, actor.user.id, connection.githubUserId),
            refreshToken: sealToken(
              refreshed.authentication.refreshToken,
              actor.user.id,
              connection.githubUserId
            ),
            expiresAt: new Date(refreshed.authentication.expiresAt),
            refreshExpiresAt: new Date(refreshed.authentication.refreshTokenExpiresAt),
          })
          .where(eq(schema.githubConnections.userId, actor.user.id))
      }
      return { token, githubUserId: connection.githubUserId }
    })
    .then(async ({ token, githubUserId }) => {
      // Persist rotated credentials before another network operation can fail.
      const octokit = new Octokit({ auth: token, request: { timeout: 30_000 } })
      const { data: user } = await octokit.users.getAuthenticated()
      if (user.id !== githubUserId)
        throw new Error("GitHub account identity changed; reconnect your account")
      return action({
        octokit,
        token,
        login: user.login,
        name: user.name || user.login,
        email: `${user.id}+${user.login}@users.noreply.github.com`,
      })
    })
    .catch((error: unknown) => {
      if (error instanceof RequestError)
        throw new Error("GitHub request failed. Check your connection and repository access.")
      throw error
    })
}

export async function disconnectGitHub() {
  const actor = await githubActor()
  await getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, actor.user.id))
      .for("update")
    const [connection] = await tx
      .select()
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.userId, actor.user.id))
    if (!connection) return
    try {
      await deleteAuthorization({
        ...githubApp(),
        token: openToken(connection.accessToken, actor.user.id, connection.githubUserId),
      })
    } catch {
      throw new Error("GitHub could not confirm revocation. Retry disconnecting.")
    }
    await tx
      .delete(schema.githubConnections)
      .where(eq(schema.githubConnections.userId, actor.user.id))
    await tx
      .delete(schema.githubAuthorizations)
      .where(eq(schema.githubAuthorizations.userId, actor.user.id))
  })
}
