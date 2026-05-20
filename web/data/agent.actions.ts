"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import { createAgent, deleteAgent, updateAgent } from "@/lib/gateway/client"
import type { CreateAgentFormState, DeleteAgentFormState } from "@/data/types"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import { agentsTag } from "@/data/cache"

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

  const result = await createAgent({ body: parsed.data })
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

  const result = await updateAgent({
    body: parsed.data,
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
  const result = await deleteAgent({ body: { agent_name: agentName } })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  redirect("/")
}
