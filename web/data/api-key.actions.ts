"use server"

import { updateTag } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import * as z from "zod"
import type { CreateAPIKeyFormState, DeleteAPIKeyFormState } from "@/data/types"
import type { Agent } from "@/lib/gateway/client"
import { listAgents, listWorkflowSummaries } from "@/lib/gateway/client"
import { createAPIKeyFormSchema } from "@/data/api-key.schema"
import { apiKeysTag } from "@/data/cache"
import { agentAPIKeyConfigID, webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getAuth } from "@/lib/auth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"

const deleteAPIKeyFormSchema = z.object({
  configId: z.union([z.literal(agentAPIKeyConfigID), z.literal(webhookAPIKeyConfigID)], {
    error: "API key configuration is required",
  }),
  keyID: z.string({ error: "API key ID is required" }).min(1, "API key ID is required"),
})

export async function createAPIKeyFormAction(
  _: CreateAPIKeyFormState,
  formData: FormData
): Promise<CreateAPIKeyFormState> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const parsed = createAPIKeyFormSchema.safeParse({
    ...Object.fromEntries(formData),
    agentNames: formData.getAll("agentNames"),
    workflowScopes: formData.getAll("workflowScopes"),
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

    updateTag(apiKeysTag)
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
  const parsed = deleteAPIKeyFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid API key",
      },
    }
  }

  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    redirect(signInURL({ error: "session_expired" }))
  }

  try {
    await auth.api.deleteApiKey({
      body: {
        configId: parsed.data.configId,
        keyId: parsed.data.keyID,
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

  updateTag(apiKeysTag)
  return { success: true }
}
