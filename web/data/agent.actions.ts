"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import { createAgent, deleteAgent, updateAgent } from "@/lib/gateway/client"
import type { CreateAgentFormState, DeleteAgentFormState } from "@/data/types"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import { agentsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function createAgentFormAction(
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = createAgentSimpleFormSchema.safeParse({
    name: formData.get("name"),
    environmentName: formData.get("environmentName"),
  })
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Agent configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.map((part) => String(part)).join("."),
          message: issue.message,
        })),
      },
    }
  }

  const result = await createAgent({ body: parsed.data, client: getGatewayServerClient() })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  redirect("/")
}

export async function updateAgentFormAction(
  agentName: string,
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = updateAgentSimpleFormSchema.safeParse({
    environmentName: formData.get("environmentName"),
    model: formData.get("model"),
    smallModel: formData.get("smallModel"),
  })
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Agent configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.map((part) => String(part)).join("."),
          message: issue.message,
        })),
      },
    }
  }

  const opencode =
    parsed.data.model || parsed.data.smallModel
      ? {
          ...(parsed.data.model ? { model: parsed.data.model } : {}),
          ...(parsed.data.smallModel ? { smallModel: parsed.data.smallModel } : {}),
        }
      : undefined

  const result = await updateAgent({
    body: {
      environmentName: parsed.data.environmentName,
      ...(opencode ? { opencode } : {}),
    },
    client: getGatewayServerClient(),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  redirect("/")
}

export async function deleteAgentFormAction(
  agentName: string,
  _: DeleteAgentFormState,
  _formData: FormData
): Promise<DeleteAgentFormState> {
  const result = await deleteAgent({
    client: getGatewayServerClient(),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  redirect("/")
}
