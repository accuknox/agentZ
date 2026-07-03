"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import type { CreateAPIKeyFormState, DeleteAPIKeyFormState } from "@/data/types"
import type { Agent } from "@/lib/gateway/client"
import { listAgents, listWorkflowSummaries } from "@/lib/gateway/client"
import { createAPIKeyFormSchema } from "@/data/api-key.schema"
import { agentAPIKeyConfigID, webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getAuth } from "@/lib/auth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"

export async function createAPIKeyFormAction(
  _: CreateAPIKeyFormState,
  formData: FormData
): Promise<CreateAPIKeyFormState> {
  const auth = getAuth()
  const requestHeaders = await headers()
  const parsed = createAPIKeyFormSchema.safeParse({
    type: formData.get("type"),
    name: formData.get("name"),
    scopeMode: formData.get("scopeMode"),
    agentNames: formData.getAll("agentNames"),
    workflowScopes: formData.getAll("workflowScopes"),
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
    redirect(signInURL({ error: "session_expired" }))
  }

  const authContext = await currentGatewayAuthContext()
  const selectedAgentNames = [...new Set(parsed.data.agentNames)].toSorted()
  const selectedWorkflowScopes = [...new Set(parsed.data.workflowScopes)].toSorted()
  let agents: Agent[] = []
  if (parsed.data.scopeMode === "selected") {
    const { data, error } = await listAgents({ client: getGatewayServerClient() })
    if (error) {
      return {
        error: {
          code: "API_KEY_CREATE_FAILED",
          message: "Failed to validate API key scope",
        },
      }
    }

    agents = data.agents.filter((agent) => agent.status !== "DELETED")
  }

  if (parsed.data.type === "agent" && parsed.data.scopeMode === "selected") {
    const allowedAgentNames = new Set(agents.map((agent) => agent.name))
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
  if (parsed.data.type === "webhook" && parsed.data.scopeMode === "selected") {
    const workflowNamesByAgent = new Map<string, Set<string>>()
    for (const scope of selectedWorkflowScopes) {
      const [kind, agentName, workflowName, extra] = scope.split(":")
      if (kind !== "workflow" || !agentName || !workflowName || extra) {
        return {
          error: {
            code: "INVALID_FORM",
            message: "Invalid workflow selection.",
          },
        }
      }

      const workflowNames = workflowNamesByAgent.get(agentName) ?? new Set<string>()
      workflowNames.add(workflowName)
      workflowNamesByAgent.set(agentName, workflowNames)
    }

    const allowedAgentNames = new Set(agents.map((agent) => agent.name))
    for (const agentName of workflowNamesByAgent.keys()) {
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

    const workflowResults = await Promise.all(
      [...workflowNamesByAgent.keys()].map(async (agentName) => {
        const { data, error } = await listWorkflowSummaries({
          client: getGatewayServerClient(),
          path: { agentName },
        })
        return { agentName, data, error }
      })
    )
    for (const result of workflowResults) {
      if (result.error) {
        return {
          error: {
            code: "API_KEY_CREATE_FAILED",
            message: "Failed to validate API key scope",
          },
        }
      }

      const allowedWorkflowNames = new Set(
        (result.data ?? []).map((workflow) => workflow.workflow_name)
      )
      for (const workflowName of workflowNamesByAgent.get(result.agentName) ?? []) {
        if (allowedWorkflowNames.has(workflowName)) {
          continue
        }

        return {
          error: {
            code: "INVALID_FORM",
            message: `Workflow ${result.agentName}/${workflowName} does not exist.`,
          },
        }
      }
    }
  }

  const configId = parsed.data.type === "agent" ? agentAPIKeyConfigID : webhookAPIKeyConfigID
  let permissions: Record<string, string[]>
  if (parsed.data.type === "agent") {
    permissions = {
      opencode:
        parsed.data.scopeMode === "all"
          ? ["all"]
          : selectedAgentNames.map((agentName) => `agent:${agentName}`),
    }
  } else {
    permissions = {
      webhook: parsed.data.scopeMode === "all" ? ["all"] : selectedWorkflowScopes,
    }
  }

  try {
    const key = await auth.api.createApiKey({
      body: {
        configId,
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
        message: "Failed to create API key",
      },
    }
  }
}

export async function deleteAPIKeyFormAction(
  _: DeleteAPIKeyFormState,
  formData: FormData
): Promise<DeleteAPIKeyFormState> {
  const auth = getAuth()
  const configId = formData.get("configId")
  const keyID = formData.get("keyID")
  if (
    (configId !== agentAPIKeyConfigID && configId !== webhookAPIKeyConfigID) ||
    typeof keyID !== "string" ||
    keyID.length === 0
  ) {
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
    redirect(signInURL({ error: "session_expired" }))
  }

  try {
    await auth.api.deleteApiKey({
      body: {
        configId,
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
        message: "Failed to revoke API key",
      },
    }
  }

  revalidatePath("/settings/api-keys")
  return { success: true }
}
