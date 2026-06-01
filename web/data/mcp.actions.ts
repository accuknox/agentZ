"use server"

import { updateTag } from "next/cache"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import {
  createMcpConnection,
  deleteMcpConnection,
  setMcpConnectionCredentials,
  updateMcpConnection,
  type Error as GatewayError,
} from "@/lib/gateway/client"
import type { McpConnectionAuth } from "@/lib/gateway/client"
import { zMcpConnectionName } from "@/lib/gateway/client/zod.gen"
import { mcpAuthLocation, mcpFormSchema, parseMcpForm, type McpFormInput } from "@/data/mcp.schema"
import {
  beginOAuthFlow,
  mcpOAuthCookieName,
  oauthCookieOptions,
  sealPendingOAuthState,
} from "@/lib/mcp-oauth"
import { oauthErrorFieldNames } from "@/lib/mcp-oauth-shared"
import { mcpsTag } from "@/data/cache"

export type McpFormState =
  | {
      error?: GatewayError
      success?: undefined
      oauth?: undefined
    }
  | {
      status: "success"
      error?: undefined
      success: true
      message?: string
      oauth?: undefined
    }
  | {
      status: "oauth_pending"
      error?: undefined
      success?: undefined
      oauth: {
        flowId: string
        url: string
      }
    }

export type DeleteMcpFormState = {
  error?: GatewayError
}

function invalidMcpFormState(error: {
  issues: { path: PropertyKey[]; message: string }[]
}): McpFormState {
  return {
    error: {
      code: "INVALID_FORM",
      message: "MCP configuration is invalid",
      errors: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    },
  }
}

function invalidMcpNameState(error: { issues: { message: string }[] }): DeleteMcpFormState {
  return {
    error: {
      code: "INVALID_FORM",
      message: "Invalid MCP name",
      errors: error.issues.map((issue) => ({
        field: "name",
        message: issue.message,
      })),
    },
  }
}

function mcpFormInput(formData: FormData): McpFormInput {
  const headerKeys = formData.getAll("extra_header_key")
  const headerValues = formData.getAll("extra_header_value")
  const modeValue = formData.get("mode")
  const currentAuthModeValue = formData.get("current_auth_mode")
  const authModeValue = formData.get("auth_mode")

  return {
    mode: modeValue === "update" ? "update" : "create",
    current_name: String(formData.get("current_name") ?? ""),
    current_auth_mode:
      currentAuthModeValue === "bearer"
        ? "bearer"
        : currentAuthModeValue === "oauth"
          ? "oauth"
          : "none",
    name: String(formData.get("name") ?? ""),
    endpoint_url: String(formData.get("endpoint_url") ?? ""),
    endpoint_timeout: String(formData.get("endpoint_timeout") ?? ""),
    extra_headers: headerKeys.map((key, index) => ({
      key: String(key ?? ""),
      value: String(headerValues[index] ?? ""),
    })),
    auth_mode: authModeValue === "bearer" ? "bearer" : "oauth",
    bearer_token: String(formData.get("bearer_token") ?? ""),
    oauth_scopes: String(formData.get("oauth_scopes") ?? ""),
    oauth_client_id: String(formData.get("oauth_client_id") ?? ""),
    oauth_client_secret: String(formData.get("oauth_client_secret") ?? ""),
    oauth_issuer: String(formData.get("oauth_issuer") ?? ""),
    oauth_authorization_endpoint: String(formData.get("oauth_authorization_endpoint") ?? ""),
    oauth_token_endpoint: String(formData.get("oauth_token_endpoint") ?? ""),
    oauth_registration_endpoint: String(formData.get("oauth_registration_endpoint") ?? ""),
    oauth_resource: String(formData.get("oauth_resource") ?? ""),
    oauth_location_header_name: String(formData.get("oauth_location_header_name") ?? ""),
    oauth_location_header_prefix: String(formData.get("oauth_location_header_prefix") ?? ""),
    bearer_location_header_name: String(formData.get("bearer_location_header_name") ?? ""),
    bearer_location_header_prefix: String(formData.get("bearer_location_header_prefix") ?? ""),
  }
}

function createPayload(input: {
  name: string
  form: ReturnType<typeof parseMcpForm>
  auth?: McpConnectionAuth
}): {
  name: string
  endpoint: ReturnType<typeof parseMcpForm>["endpoint"]
  auth?: McpConnectionAuth
} {
  return {
    name: input.name,
    endpoint: input.form.endpoint,
    auth: input.auth ?? (input.form.authMode === "bearer" ? bearerAuth(input.form) : undefined),
  }
}

function bearerAuth(input: ReturnType<typeof parseMcpForm>) {
  return {
    bearer: {
      location: input.bearer?.location ?? mcpAuthLocation(),
    },
  } satisfies McpConnectionAuth
}

async function persistBearerMutation(
  form: ReturnType<typeof parseMcpForm>
): Promise<GatewayError | undefined> {
  const payload = createPayload({
    name: form.name,
    form,
    auth: bearerAuth(form),
  })
  if (form.mode === "create") {
    const createResult = await createMcpConnection({
      body: payload,
    })
    if (createResult.error) {
      return createResult.error
    }
  } else {
    const updateResult = await updateMcpConnection({
      path: { name: form.currentName ?? form.name },
      body: {
        endpoint: payload.endpoint,
        auth: payload.auth,
      },
    })
    if (updateResult.error) {
      return updateResult.error
    }
  }

  if (!form.bearerToken) {
    return undefined
  }

  const credentialsResult = await setMcpConnectionCredentials({
    path: { name: form.currentName ?? form.name },
    body: {
      bearer: {
        token: form.bearerToken,
      },
    },
  })
  return credentialsResult.error
}

export async function submitMcpFormAction(
  _: McpFormState,
  formData: FormData
): Promise<McpFormState> {
  const parsed = mcpFormSchema.safeParse(mcpFormInput(formData))
  if (!parsed.success) {
    return invalidMcpFormState(parsed.error)
  }

  const form = parseMcpForm(parsed.data)
  if (form.authMode === "oauth") {
    const result =
      form.mode === "create"
        ? await beginOAuthFlow({
            kind: "create",
            form,
          })
        : await beginOAuthFlow({
            kind: "update",
            name: form.currentName ?? form.name,
            form,
          })
    if (!result.ok) {
      const errors = result.error.field
        ? result.error.code === "manual_client_credentials_required"
          ? oauthErrorFieldNames.map((field) => ({
              field,
              message: result.error.message,
            }))
          : [
              {
                field: result.error.field,
                message: result.error.message,
              },
            ]
        : undefined

      return {
        error: {
          code: result.error.code,
          message: result.error.message,
          errors,
        },
      }
    }

    try {
      const cookieStore = await cookies()
      cookieStore.set(
        mcpOAuthCookieName(),
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
    } catch (error) {
      return {
        error: {
          code: "OAUTH_START_FAILED",
          message: error instanceof Error ? error.message : "OAuth flow could not be started",
        },
      }
    }
  }

  const mutationError = await persistBearerMutation(form)
  if (mutationError) {
    return { error: mutationError }
  }

  updateTag(mcpsTag)
  return { status: "success", success: true }
}

export async function deleteMcpFormAction(
  name: string,
  _: DeleteMcpFormState,
  _formData: FormData
): Promise<DeleteMcpFormState> {
  const parsedName = zMcpConnectionName.safeParse(name)
  if (!parsedName.success) {
    return invalidMcpNameState(parsedName.error)
  }

  const result = await deleteMcpConnection({
    path: { name: parsedName.data },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(mcpsTag)
  redirect("/mcps")
}
