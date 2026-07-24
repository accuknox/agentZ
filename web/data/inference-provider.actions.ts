"use server"

import { cookies } from "next/headers"
import { updateTag } from "next/cache"
import * as z from "zod"
import {
  createInferenceProviderOAuthTicket,
  createInferenceProvider,
  deleteInferenceProvider,
  getInferenceProviderUsage,
  listInferenceProviderCatalog,
  listInferenceModelSuggestions,
  refreshInferenceProviderModels,
  updateInferenceProvider,
  type CreateInferenceProviderRequestWritable,
  type CreateInferenceProviderOAuthTicketResponse,
  type Error as GatewayError,
  type InferenceProvider,
  type InferenceModelSuggestions,
  type InferenceProviderCatalog,
  type InferenceProviderKind,
  type InferenceProviderUsage,
  type UpdateInferenceProviderRequestWritable,
} from "@/lib/gateway/client"
import {
  zCreateInferenceProviderRequestWritable,
  zInferenceProviderCatalogEntry,
  zInferenceProviderName,
  zInferenceProviderKind,
  zUpdateInferenceProviderRequestWritable,
} from "@/lib/gateway/client/zod.gen"
import { inferenceProvidersTag, sandboxesTag } from "@/data/cache"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import type { InferenceProvidersResult } from "@/data/inference-provider.queries"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { openOAuthState, sealOAuthState } from "@/lib/oauth-state"

const inferenceOAuthCookieName = "agentz_inference_provider_oauth"
const openAICodexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
const gitHubCopilotClientID = "Ov23li8tweQw6odWQebz"
const oauthUserAgent = "agentz/1.0"
const inferenceOAuthKindSchema = z.enum(["OpenAICodex", "GitHubCopilot"])
const gatewayAuthContextSchema = z.object({
  organizationId: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
})
const pendingInferenceOAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("OpenAICodex"),
    initiator: gatewayAuthContextSchema,
    deviceAuthId: z.string().min(1),
    userCode: z.string().min(1),
    interval: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("GitHubCopilot"),
    initiator: gatewayAuthContextSchema,
    deviceCode: z.string().min(1),
    interval: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  }),
])
const openAIDeviceResponseSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.string().regex(/^[1-9][0-9]*$/),
})
const openAIAuthorizationResponseSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
})
const openAITokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
})
const gitHubDeviceResponseSchema = z.object({
  verification_uri: z.url(),
  user_code: z.string().min(1),
  device_code: z.string().min(1),
  interval: z.number().int().positive(),
  expires_in: z.number().int().positive(),
})
const gitHubTokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  interval: z.number().int().positive().optional(),
})

type InferenceOAuthChallenge = {
  status: "challenge"
  verificationUri: string
  userCode: string
  interval: number
  expiresAt: string
}

type InferenceOAuthPoll =
  | { status: "pending"; interval: number }
  | { status: "connected"; connection: CreateInferenceProviderOAuthTicketResponse }
  | { status: "error"; message: string }

type SaveInferenceProviderState =
  | { provider: InferenceProvider; error?: undefined }
  | { provider?: undefined; error: GatewayError }

type SuggestInferenceModelsState =
  | { data: InferenceModelSuggestions; error?: undefined }
  | { data?: undefined; error: GatewayError }

type ListInferenceProviderCatalogState =
  | { data: InferenceProviderCatalog; error?: undefined }
  | { data?: undefined; error: GatewayError }

type SaveInferenceProviderInput =
  | { providerName: string; body: UpdateInferenceProviderRequestWritable }
  | { providerName?: undefined; body: CreateInferenceProviderRequestWritable }

export async function startInferenceProviderOAuthAction(
  value: InferenceProviderKind
): Promise<InferenceOAuthChallenge | { status: "error"; message: string }> {
  const kind = inferenceOAuthKindSchema.safeParse(value)
  if (!kind.success) {
    return { status: "error", message: "Select a subscription provider" }
  }

  const initiator = await currentGatewayAuthContext()
  try {
    if (kind.data === "OpenAICodex") {
      const response = await fetch("https://auth.openai.com/api/accounts/deviceauth/usercode", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": oauthUserAgent,
        },
        body: JSON.stringify({ client_id: openAICodexClientID }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        return { status: "error", message: "OpenAI sign-in could not be started" }
      }
      const device = openAIDeviceResponseSchema.parse(await response.json())
      const interval = Number.parseInt(device.interval, 10)
      const expiresAt = Date.now() + 10 * 60 * 1000
      const cookieStore = await cookies()
      cookieStore.set(
        inferenceOAuthCookieName,
        await sealOAuthState(
          {
            kind: kind.data,
            initiator,
            deviceAuthId: device.device_auth_id,
            userCode: device.user_code,
            interval,
            expiresAt,
          },
          "inference-provider"
        ),
        {
          httpOnly: true,
          sameSite: "strict",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 10 * 60,
        }
      )
      return {
        status: "challenge",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: device.user_code,
        interval,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    }

    const response = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": oauthUserAgent,
      },
      body: JSON.stringify({ client_id: gitHubCopilotClientID, scope: "read:user" }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return { status: "error", message: "GitHub sign-in could not be started" }
    }
    const device = gitHubDeviceResponseSchema.parse(await response.json())
    const expiresAt = Date.now() + device.expires_in * 1000
    const cookieStore = await cookies()
    cookieStore.set(
      inferenceOAuthCookieName,
      await sealOAuthState(
        {
          kind: kind.data,
          initiator,
          deviceCode: device.device_code,
          interval: device.interval,
          expiresAt,
        },
        "inference-provider"
      ),
      {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: device.expires_in,
      }
    )
    return {
      status: "challenge",
      verificationUri: device.verification_uri,
      userCode: device.user_code,
      interval: device.interval,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  } catch {
    return { status: "error", message: "Sign-in could not be started" }
  }
}

export async function pollInferenceProviderOAuthAction(): Promise<InferenceOAuthPoll> {
  const cookieStore = await cookies()
  const sealed = cookieStore.get(inferenceOAuthCookieName)?.value
  if (!sealed) {
    return { status: "error", message: "Sign-in expired. Please try again." }
  }

  let pending: z.infer<typeof pendingInferenceOAuthSchema>
  try {
    pending = pendingInferenceOAuthSchema.parse(await openOAuthState(sealed, "inference-provider"))
  } catch {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "Sign-in could not be completed. Please try again." }
  }

  const initiator = await currentGatewayAuthContext()
  if (
    pending.initiator.organizationId !== initiator.organizationId ||
    pending.initiator.sessionId !== initiator.sessionId ||
    pending.initiator.userId !== initiator.userId
  ) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "Sign-in can no longer be used. Please try again." }
  }
  if (pending.expiresAt <= Date.now()) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "Sign-in expired. Please try again." }
  }

  try {
    if (pending.kind === "OpenAICodex") {
      return await pollOpenAICodex(pending, cookieStore)
    }
    return await pollGitHubCopilot(pending, cookieStore)
  } catch {
    return { status: "error", message: "Sign-in could not be completed. Please try again." }
  }
}

async function pollOpenAICodex(
  pending: Extract<z.infer<typeof pendingInferenceOAuthSchema>, { kind: "OpenAICodex" }>,
  cookieStore: Awaited<ReturnType<typeof cookies>>
): Promise<InferenceOAuthPoll> {
  const response = await fetch("https://auth.openai.com/api/accounts/deviceauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": oauthUserAgent,
    },
    body: JSON.stringify({
      device_auth_id: pending.deviceAuthId,
      user_code: pending.userCode,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 403 || response.status === 404) {
    return { status: "pending", interval: pending.interval }
  }
  if (!response.ok) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "OpenAI sign-in was not approved" }
  }
  const authorization = openAIAuthorizationResponseSchema.parse(await response.json())
  const tokenResponse = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorization.authorization_code,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      client_id: openAICodexClientID,
      code_verifier: authorization.code_verifier,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!tokenResponse.ok) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "OpenAI sign-in could not be completed" }
  }
  const tokens = openAITokenResponseSchema.parse(await tokenResponse.json())
  const result = await createInferenceProviderOAuthTicket({
    body: {
      kind: pending.kind,
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
      },
    },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { status: "error", message: "Your subscription could not be connected" }
  }
  cookieStore.delete(inferenceOAuthCookieName)
  return { status: "connected", connection: result.data }
}

async function pollGitHubCopilot(
  pending: Extract<z.infer<typeof pendingInferenceOAuthSchema>, { kind: "GitHubCopilot" }>,
  cookieStore: Awaited<ReturnType<typeof cookies>>
): Promise<InferenceOAuthPoll> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": oauthUserAgent,
    },
    body: JSON.stringify({
      client_id: gitHubCopilotClientID,
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    return { status: "error", message: "GitHub sign-in could not be checked" }
  }
  const token = gitHubTokenResponseSchema.parse(await response.json())
  if (token.error === "authorization_pending") {
    return { status: "pending", interval: pending.interval }
  }
  if (token.error === "slow_down") {
    pending.interval = token.interval ?? pending.interval + 5
    cookieStore.set(inferenceOAuthCookieName, await sealOAuthState(pending, "inference-provider"), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: Math.max(Math.ceil((pending.expiresAt - Date.now()) / 1000), 1),
    })
    return { status: "pending", interval: pending.interval }
  }
  if (!token.access_token) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "GitHub sign-in was not approved" }
  }
  const result = await createInferenceProviderOAuthTicket({
    body: {
      kind: pending.kind,
      credentials: { access_token: token.access_token },
    },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { status: "error", message: "Your subscription could not be connected" }
  }
  cookieStore.delete(inferenceOAuthCookieName)
  return { status: "connected", connection: result.data }
}

export async function saveInferenceProviderAction(
  input: SaveInferenceProviderInput
): Promise<SaveInferenceProviderState> {
  let result
  if (input.providerName !== undefined) {
    const providerName = zInferenceProviderName.safeParse(input.providerName)
    if (!providerName.success) {
      return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
    }
    const parsed = zUpdateInferenceProviderRequestWritable.safeParse(input.body)
    if (!parsed.success) {
      return {
        error: {
          code: "INVALID_FORM",
          message: "Provider configuration is invalid",
          errors: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      }
    }
    result = await updateInferenceProvider({
      path: { providerName: providerName.data },
      body: parsed.data,
      client: getGatewayServerClient(),
    })
  } else {
    const parsed = zCreateInferenceProviderRequestWritable.safeParse(input.body)
    if (!parsed.success) {
      return {
        error: {
          code: "INVALID_FORM",
          message: "Provider configuration is invalid",
          errors: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      }
    }
    result = await createInferenceProvider({
      body: parsed.data,
      client: getGatewayServerClient(),
    })
  }
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  return { provider: result.data }
}

export async function deleteInferenceProviderAction(
  name: string
): Promise<{ error?: GatewayError }> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid provider ID",
      },
    }
  }
  const result = await deleteInferenceProvider({
    path: { providerName: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  return {}
}

export async function getInferenceProviderUsageAction(
  name: string
): Promise<{ usage?: InferenceProviderUsage; error?: GatewayError }> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
  }
  const result = await getInferenceProviderUsage({
    path: { providerName: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  return { usage: result.data }
}

export async function refreshInferenceProvidersAction(): Promise<InferenceProvidersResult> {
  updateTag(inferenceProvidersTag)
  return listInferenceProvidersCachedQuery()
}

export async function listInferenceProviderCatalogAction(): Promise<ListInferenceProviderCatalogState> {
  const result = await listInferenceProviderCatalog({ client: getGatewayServerClient() })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}

export async function suggestInferenceModelsAction(
  catalogProvider: string,
  providerKind: InferenceProviderKind
): Promise<SuggestInferenceModelsState> {
  const provider = zInferenceProviderCatalogEntry.shape.provider_id.safeParse(catalogProvider)
  if (!provider.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid catalog provider" } }
  }
  const parsed = zInferenceProviderKind.safeParse(providerKind)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider kind" } }
  }
  const result = await listInferenceModelSuggestions({
    path: { catalogProvider: provider.data },
    query: { provider_kind: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}

export async function refreshInferenceProviderModelsAction(
  name: string
): Promise<SuggestInferenceModelsState> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
  }
  const result = await refreshInferenceProviderModels({
    path: { providerName: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}
