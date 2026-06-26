"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import type { CreateAPIKeyFormState, DeleteAPIKeyFormState } from "@/data/types"
import { listAgents } from "@/lib/gateway/client"
import { createAPIKeyFormSchema } from "@/data/api-key.schema"
import { getAuth } from "@/lib/auth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { gatewayServerClient } from "@/lib/gateway/server-client"
import { opencodeAPIKeyConfigID } from "@/lib/auth"
import { loginURL } from "@/lib/login-redirect"

export async function createAPIKeyFormAction(
  _: CreateAPIKeyFormState,
  formData: FormData
): Promise<CreateAPIKeyFormState> {
  const auth = getAuth()
  const requestHeaders = await headers()
  const parsed = createAPIKeyFormSchema.safeParse({
    name: formData.get("name"),
    scopeMode: formData.get("scopeMode"),
    agentNames: formData.getAll("agentNames"),
    expiresInDays: formData.get("expiresInDays"),
  })
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: parsed.error.issues[0]?.message ?? "Invalid API key configuration",
      },
    }
  }

  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    redirect(loginURL({ error: "session_expired" }))
  }

  const authContext = await currentGatewayAuthContext()
  const selectedAgentNames = [...new Set(parsed.data.agentNames)].toSorted()
  if (parsed.data.scopeMode === "selected") {
    const { data, error } = await listAgents({ client: gatewayServerClient })
    if (error) {
      return {
        error: {
          code: "API_KEY_CREATE_FAILED",
          message: "Failed to validate API key scope",
        },
      }
    }

    const allowedAgentNames = new Set(
      data.agents.filter((agent) => agent.status !== "DELETED").map((agent) => agent.name)
    )
    for (const agentName of selectedAgentNames) {
      if (allowedAgentNames.has(agentName)) {
        continue
      }

      return {
        error: {
          code: "INVALID_FORM",
          message: `Agent ${agentName} does not exist.`,
        },
      }
    }
  }

  const permissions = {
    opencode:
      parsed.data.scopeMode === "all"
        ? ["all"]
        : selectedAgentNames.map((agentName) => `agent:${agentName}`),
  } satisfies Record<string, string[]>

  try {
    const key = await auth.api.createApiKey({
      body: {
        configId: opencodeAPIKeyConfigID,
        expiresIn:
          parsed.data.expiresInDays === "none"
            ? null
            : Number(parsed.data.expiresInDays) * 24 * 60 * 60,
        name: parsed.data.name,
        organizationId: authContext.organizationId,
        permissions,
        userId: authContext.userId,
      },
    })

    revalidatePath("/settings/api-keys")
    return {
      key: {
        id: key.id,
        name: key.name,
        secret: key.key,
      },
    }
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }

    return {
      error: {
        code: "API_KEY_CREATE_FAILED",
        message: error instanceof Error ? error.message : "Failed to create API key",
      },
    }
  }
}

export async function deleteAPIKeyFormAction(
  _: DeleteAPIKeyFormState,
  formData: FormData
): Promise<DeleteAPIKeyFormState> {
  const auth = getAuth()
  const keyID = formData.get("keyID")
  if (typeof keyID !== "string" || keyID.length === 0) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid API key",
      },
    }
  }

  const requestHeaders = await headers()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    redirect(loginURL({ error: "session_expired" }))
  }

  try {
    await auth.api.deleteApiKey({
      body: {
        configId: opencodeAPIKeyConfigID,
        keyId: keyID,
      },
      headers: requestHeaders,
    })
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }

    return {
      error: {
        code: "API_KEY_DELETE_FAILED",
        message: error instanceof Error ? error.message : "Failed to revoke API key",
      },
    }
  }

  revalidatePath("/settings/api-keys")
  return { success: true }
}
