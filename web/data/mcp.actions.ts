"use server"

import { updateTag } from "next/cache"
import { cookies } from "next/headers"
import {
  createMcpConnection,
  getMcpConnection,
  reauthenticateMcpConnection,
  deleteMcpConnection,
  type Error as GatewayError,
} from "@/lib/gateway/client"
import { zMcpConnectionName } from "@/lib/gateway/client/zod.gen"
import { defaultMcpAuthLocation, mcpFormSchema, parseMcpForm } from "@/data/mcp.schema"
import {
  beginOAuthFlow,
  mcpOAuthCookieName,
  oauthCookieOptions,
  sealPendingOAuthState,
} from "@/lib/mcp-oauth"
import { oauthErrorFieldNames } from "@/lib/mcp-oauth-shared"
import { mcpsTag } from "@/data/cache"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { activateOrganization } from "@/data/organizations"

export type McpActionScope = { basePath: string; organizationId: string; workspaceId?: string }

export type McpFormState =
  | {
      status?: undefined
      error?: undefined
      success?: undefined
      oauth?: undefined
      message?: undefined
    }
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

export type SubmitMcpFormAction =
  | {
      type: "reset"
    }
  | {
      type: "submit"
      formData: FormData
    }

export type DeleteMcpFormState = {
  error?: GatewayError
  success?: boolean
}

export async function submitScopedMcpFormAction(
  scope: McpActionScope,
  _: McpFormState,
  action: SubmitMcpFormAction
): Promise<McpFormState> {
  if (!(await activateOrganization(scope.organizationId))) {
    return { error: { code: "FORBIDDEN", message: "Organisation access is unavailable." } }
  }
  if (action.type === "reset") {
    return {}
  }

  const formData = action.formData
  const headerKeys = formData.getAll("extra_header_key")
  const headerValues = formData.getAll("extra_header_value")
  const parsed = mcpFormSchema.safeParse({
    ...Object.fromEntries(formData),
    extra_headers: headerKeys.map((key, index) => ({
      key,
      value: headerValues[index],
    })),
  })
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "MCP configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    }
  }

  const form = parseMcpForm(parsed.data)
  if (form.authMode === "oauth") {
    const authContext = await currentGatewayAuthContext()
    const result = await beginOAuthFlow({
      initiator: authContext,
      operation: {
        kind: "create",
        form,
        workspaceId: scope.workspaceId,
      },
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
    } catch (error) {
      return {
        error: {
          code: "OAUTH_START_FAILED",
          message: error instanceof Error ? error.message : "OAuth flow could not be started",
        },
      }
    }
  }

  const token = form.bearerToken
  if (!token) return { error: { code: "INVALID_FORM", message: "Token is required" } }
  const result = await createMcpConnection({
    body: {
      name: form.name,
      endpoint: form.endpoint,
      auth: { bearer: { location: form.bearerLocation ?? defaultMcpAuthLocation } },
      credentials: { bearer: { token } },
    },
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) return { error: result.error }

  updateTag(mcpsTag)
  return { status: "success", success: true }
}

export async function deleteScopedMcpFormAction(
  scope: McpActionScope,
  name: string,
  _: DeleteMcpFormState,
  _formData: FormData
): Promise<DeleteMcpFormState> {
  if (!(await activateOrganization(scope.organizationId))) {
    return { error: { code: "FORBIDDEN", message: "Organisation access is unavailable." } }
  }
  const parsedName = zMcpConnectionName.safeParse(name)
  if (!parsedName.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid MCP name",
        errors: parsedName.error.issues.map((issue) => ({ field: "name", message: issue.message })),
      },
    }
  }

  const result = await deleteMcpConnection({
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
    path: { name: parsedName.data },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(mcpsTag)
  return { success: true }
}

export async function reauthenticateMcpAction(
  name: string,
  resourceVersion: string,
  token: string,
  workspaceId?: string,
  clientId?: string,
  clientSecret?: string
): Promise<McpFormState> {
  const client = getGatewayServerClient(workspaceId)
  const headers = workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined
  const loaded = await getMcpConnection({
    path: { name },
    query: { scope: workspaceId ? "Workspace" : "Organisation" },
    client,
    headers,
  })
  if (loaded.error) return { error: loaded.error }
  const connection = loaded.data
  if (!connection.can_reauthenticate)
    return { error: { code: "forbidden", message: "You cannot re-authenticate this connection." } }
  if (connection.resource_version !== resourceVersion) {
    return { error: { code: "conflict", message: "Connection changed. Reload before retrying." } }
  }
  if (connection.auth.oauth) {
    const oauth = connection.auth.oauth
    const result = await beginOAuthFlow({
      initiator: await currentGatewayAuthContext(),
      operation: {
        kind: "reauthenticate",
        resourceVersion,
        workspaceId,
        form: {
          name,
          endpoint: connection.endpoint,
          authMode: "oauth",
          oauth: {
            issuer: oauth.issuer,
            authorizationEndpoint: oauth.authorization_endpoint,
            tokenEndpoint: oauth.token_endpoint,
            registrationEndpoint: oauth.registration_endpoint,
            resource: oauth.resource,
            scopes: oauth.scopes,
            location: oauth.location,
            clientId,
            clientSecret,
          },
        },
      },
    })
    if (!result.ok) return { error: { code: result.error.code, message: result.error.message } }
    const cookieStore = await cookies()
    cookieStore.set(
      mcpOAuthCookieName,
      await sealPendingOAuthState(result.value.pending),
      oauthCookieOptions()
    )
    return {
      status: "oauth_pending",
      oauth: { flowId: result.value.pending.flowId, url: result.value.authorizationURL.toString() },
    }
  }
  const saved = await reauthenticateMcpConnection({
    path: { name },
    body: { resource_version: resourceVersion, credentials: { bearer: { token } } },
    client,
    headers,
  })
  if (saved.error) return { error: saved.error }
  updateTag(mcpsTag)
  return { status: "success", success: true }
}
