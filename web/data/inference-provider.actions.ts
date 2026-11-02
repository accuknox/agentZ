"use server"

import { cookies } from "next/headers"
import { updateTag } from "next/cache"
import * as z from "zod"
import {
  createInferenceProviderOAuthTicket,
  reauthenticateInferenceProviderOAuthTicket,
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
  zCreateInferenceProviderOAuthTicketRequest,
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
import { dayjs } from "@/lib/format"

const inferenceOAuthCookieName = "agentz_inference_provider_oauth"
const openAICodexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
const oauthUserAgent = "agentz/1.0"
const pendingInferenceOAuthSchema = z.object({
  provider: z.object({ id: z.string().min(1), resourceVersion: z.string().min(1) }).optional(),
  kind: zCreateInferenceProviderOAuthTicketRequest.shape.kind,
  initiator: z.object({
    organizationId: z.string().min(1),
    sessionId: z.string().min(1),
    userId: z.string().min(1),
  }),
  workspaceId: z.string().min(1).optional(),
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
  interval: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})
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

type InferenceOAuthChallenge = {
  status: "challenge"
  verificationUri: string
  userCode: string
  interval: number
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

export type InferenceProviderActionScope = { workspaceId?: string }

export async function startInferenceProviderOAuthAction(
  scope: InferenceProviderActionScope,
  value: InferenceProviderKind,
  provider?: z.infer<typeof pendingInferenceOAuthSchema>["provider"]
): Promise<InferenceOAuthChallenge | { status: "error"; message: string }> {
  const kind = pendingInferenceOAuthSchema.shape.kind.safeParse(value)
  if (!kind.success) {
    return { status: "error", message: "Select a subscription provider" }
  }

  const initiator = await currentGatewayAuthContext()
  try {
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
    const expiresAt = dayjs().add(10, "minutes").valueOf()
    const cookieStore = await cookies()
    cookieStore.set(
      inferenceOAuthCookieName,
      await sealOAuthState(
        {
          kind: kind.data,
          provider,
          initiator,
          workspaceId: scope.workspaceId,
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
    }
  } catch {
    return { status: "error", message: "Sign-in could not be started" }
  }
}

export async function pollInferenceProviderOAuthAction(
  scope: InferenceProviderActionScope
): Promise<InferenceOAuthPoll> {
  const cookieStore = await cookies()
  const sealed = cookieStore.get(inferenceOAuthCookieName)?.value
  if (!sealed) {
    return { status: "error", message: "Sign-in expired. Start again." }
  }

  let pending: z.infer<typeof pendingInferenceOAuthSchema>
  try {
    pending = pendingInferenceOAuthSchema.parse(await openOAuthState(sealed, "inference-provider"))
  } catch {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "We couldn't complete sign-in. Start again." }
  }

  const initiator = await currentGatewayAuthContext()
  if (
    pending.initiator.organizationId !== initiator.organizationId ||
    pending.initiator.sessionId !== initiator.sessionId ||
    pending.initiator.userId !== initiator.userId ||
    pending.workspaceId !== scope.workspaceId
  ) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "This sign-in is no longer valid. Start again." }
  }
  if (!dayjs(pending.expiresAt).isAfter(dayjs())) {
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "error", message: "Sign-in expired. Start again." }
  }

  try {
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
    const options = {
      body: {
        kind: pending.kind,
        resource_version: pending.provider?.resourceVersion,
        credentials: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          id_token: tokens.id_token,
          expires_at: dayjs()
            .add(tokens.expires_in ?? 3600, "seconds")
            .toISOString(),
        },
      },
      client: getGatewayServerClient(scope.workspaceId),
      headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
    }
    const result = pending.provider
      ? await reauthenticateInferenceProviderOAuthTicket({
          ...options,
          path: { providerName: pending.provider.id },
        })
      : await createInferenceProviderOAuthTicket(options)
    if (result.error) {
      return { status: "error", message: "Your subscription could not be connected" }
    }
    cookieStore.delete(inferenceOAuthCookieName)
    return { status: "connected", connection: result.data }
  } catch {
    return { status: "error", message: "We couldn't complete sign-in. Start again." }
  }
}

export async function saveInferenceProviderAction(
  scope: InferenceProviderActionScope,
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
      client: getGatewayServerClient(scope.workspaceId),
      headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
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
      client: getGatewayServerClient(scope.workspaceId),
      headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
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
  scope: InferenceProviderActionScope,
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
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  return {}
}

export async function getInferenceProviderUsageAction(
  scope: InferenceProviderActionScope,
  name: string
): Promise<{ usage?: InferenceProviderUsage; error?: GatewayError }> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
  }
  const result = await getInferenceProviderUsage({
    path: { providerName: parsed.data },
    query: { scope: scope.workspaceId ? "Workspace" : "Organisation" },
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) {
    return { error: result.error }
  }
  return { usage: result.data }
}

export async function refreshInferenceProvidersAction(
  scope: InferenceProviderActionScope
): Promise<InferenceProvidersResult> {
  updateTag(inferenceProvidersTag)
  return listInferenceProvidersCachedQuery(scope.workspaceId)
}

export async function listInferenceProviderCatalogAction(
  scope: InferenceProviderActionScope
): Promise<ListInferenceProviderCatalogState> {
  const result = await listInferenceProviderCatalog({
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}

export async function suggestInferenceModelsAction(
  scope: InferenceProviderActionScope,
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
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}

export async function refreshInferenceProviderModelsAction(
  scope: InferenceProviderActionScope,
  name: string
): Promise<SuggestInferenceModelsState> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
  }
  const result = await refreshInferenceProviderModels({
    path: { providerName: parsed.data },
    query: { scope: scope.workspaceId ? "Workspace" : "Organisation" },
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}
