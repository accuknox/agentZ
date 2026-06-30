"use server"

import { cookies } from "next/headers"
import { updateTag } from "next/cache"
import { redirect } from "next/navigation"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { deleteSecret, putSecret } from "@/lib/gateway/client"
import type { CreateSecretRequest } from "@/lib/gateway/client"
import { zSecretKey } from "@/lib/gateway/client/zod.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import {
  beginOAuthFlow,
  mcpOAuthCookieName,
  oauthCookieOptions,
  sealPendingOAuthState,
} from "@/lib/mcp-oauth"
import { agentSecretsTag, secretsTag } from "@/data/cache"
import { defaultMcpAuthLocation, type ParsedMcpForm } from "@/data/mcp.schema"
import { oauthSecretFormInputSchema, secretHostsInputSchema, secretValueSchema } from "./schema"
import type { DeleteSecretFormState, PutSecretFormState } from "./types"

export async function putSecretFormAction(
  agentName: string,
  _: PutSecretFormState,
  formData: FormData
): Promise<PutSecretFormState> {
  const key = formData.get("key")
  const value = formData.get("value")
  const hosts = formData.get("hosts")

  const parsedKey = zSecretKey.safeParse(key)
  if (!parsedKey.success) {
    return invalidFieldState(
      "key",
      parsedKey.error.issues.map((issue) => issue.message)
    )
  }

  const parsedValue = secretValueSchema.safeParse(value)
  if (!parsedValue.success) {
    return invalidFieldState(
      "value",
      parsedValue.error.issues.map((issue) => issue.message)
    )
  }

  const parsedHosts = secretHostsInputSchema.safeParse(hosts)
  if (!parsedHosts.success) {
    return invalidFieldState(
      "hosts",
      parsedHosts.error.issues.map((issue) => issue.message)
    )
  }

  const result = await putSecret({
    client: getGatewayServerClient(),
    path: { agentName },
    body: {
      type: "static",
      key: parsedKey.data,
      value: parsedValue.data.trim(),
      hosts: parsedHosts.data,
    } satisfies CreateSecretRequest,
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(secretsTag)
  updateTag(agentSecretsTag(agentName))
  redirect(`/secrets?agent_name=${encodeURIComponent(agentName)}`)
}

export async function startOAuthSecretFormAction(
  agentName: string,
  _: PutSecretFormState,
  formData: FormData
): Promise<PutSecretFormState> {
  const parsed = oauthSecretFormInputSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "OAuth secret configuration is invalid.",
        errors: parsed.error.issues.flatMap((issue) => {
          const field = issue.path[0]
          return typeof field === "string"
            ? [
                {
                  field,
                  message: issue.message,
                },
              ]
            : []
        }),
      },
    }
  }

  const parsedHosts = secretHostsInputSchema.safeParse(parsed.data.hosts)
  if (!parsedHosts.success) {
    return invalidFieldState(
      "hosts",
      parsedHosts.error.issues.map((issue) => issue.message)
    )
  }

  const parsedKey = zSecretKey.safeParse(parsed.data.key)
  if (!parsedKey.success) {
    return invalidFieldState(
      "key",
      parsedKey.error.issues.map((issue) => issue.message)
    )
  }

  const scopes = parsed.data.scopes
    .split(/\r?\n+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
  const form: ParsedMcpForm = {
    name: parsed.data.key,
    endpoint: {
      url: parsed.data.endpoint_url,
      insecure_skip_verify: false,
      headers: {},
    },
    authMode: "oauth",
    oauth: {
      issuer: parsed.data.issuer,
      authorizationEndpoint: parsed.data.authorization_endpoint,
      tokenEndpoint: parsed.data.token_endpoint,
      registrationEndpoint: parsed.data.registration_endpoint,
      resource: parsed.data.resource,
      scopes,
      location: defaultMcpAuthLocation,
      clientId: parsed.data.client_id || undefined,
      clientSecret: parsed.data.client_secret || undefined,
    },
  }

  const authContext = await currentGatewayAuthContext()
  const result = await beginOAuthFlow({
    initiator: authContext,
    operation: {
      kind: "secret",
      form,
      secret: {
        agentName,
        key: parsedKey.data,
        hosts: parsedHosts.data,
        provider: parsed.data.provider,
      },
    },
  })
  if (!result.ok) {
    if (result.error.code === "manual_client_credentials_required") {
      return {
        error: {
          code: result.error.code,
          message: result.error.message,
          errors: [
            {
              field: "client_id",
              message: "Client ID is required.",
            },
            {
              field: "client_secret",
              message: "Client secret is required.",
            },
          ],
        },
      }
    }

    const field =
      result.error.field === "oauth_client_id"
        ? "client_id"
        : result.error.field === "oauth_client_secret"
          ? "client_secret"
          : result.error.field
    return {
      error: {
        code: result.error.code,
        message: result.error.message,
        errors: field
          ? [
              {
                field,
                message: result.error.message,
              },
            ]
          : undefined,
      },
    }
  }

  const cookieStore = await cookies()
  cookieStore.set(
    mcpOAuthCookieName,
    await sealPendingOAuthState(result.value.pending),
    oauthCookieOptions()
  )

  return {
    status: "oauth_pending",
    oauth: {
      flowId: result.value.pending.flowId,
      url: result.value.authorizationURL.toString(),
    },
  }
}

export async function deleteSecretFormAction(
  agentName: string,
  _: DeleteSecretFormState,
  formData: FormData
): Promise<DeleteSecretFormState> {
  const key = formData.get("key")
  const parsedKey = zSecretKey.safeParse(key)
  if (!parsedKey.success) {
    return invalidFieldState(
      "key",
      parsedKey.error.issues.map((issue) => issue.message)
    )
  }

  const result = await deleteSecret({
    client: getGatewayServerClient(),
    path: { agentName },
    body: {
      keys: [parsedKey.data],
    },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(secretsTag)
  updateTag(agentSecretsTag(agentName))
  redirect(`/secrets?agent_name=${encodeURIComponent(agentName)}`)
}

function invalidFieldState(field: string, messages: string[]): PutSecretFormState {
  return {
    error: {
      code: "INVALID_FORM",
      message: "Secret configuration is invalid",
      errors: messages.map((message) => ({
        field,
        message,
      })),
    },
  }
}
