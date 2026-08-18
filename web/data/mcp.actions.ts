"use server"

import { updateTag } from "next/cache"
import { cookies } from "next/headers"
import {
  createMcpConnection,
  deleteMcpConnection,
  type Error as GatewayError,
} from "@/lib/gateway/client"
import type { McpConnectionAuth } from "@/lib/gateway/client"
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

function bearerAuth(input: ReturnType<typeof parseMcpForm>) {
  return {
    bearer: {
      location: input.bearerLocation ?? defaultMcpAuthLocation,
    },
  } satisfies McpConnectionAuth
}

async function persistBearerMutation(
  form: ReturnType<typeof parseMcpForm>,
  workspaceId?: string
): Promise<GatewayError | undefined> {
  const auth = bearerAuth(form)
  const credentials = form.bearerToken
    ? {
        bearer: {
          token: form.bearerToken,
        },
      }
    : {
        bearer: {
          token: "override-required",
        },
      }
  const createResult = await createMcpConnection({
    body: {
      name: form.name,
      endpoint: form.endpoint,
      auth,
      credentials,
    },
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
  if (createResult.error) {
    return createResult.error
  }
  return undefined
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
    return invalidMcpFormState(parsed.error)
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

  const mutationError = await persistBearerMutation(form, scope.workspaceId)
  if (mutationError) {
    return { error: mutationError }
  }

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
    return invalidMcpNameState(parsedName.error)
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
