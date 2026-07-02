"use server"

import * as z from "zod"
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
    sandboxName: formData.get("sandboxName"),
  })
  if (!parsed.success) {
    return invalidAgentFormState(parsed.error)
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
  const model = formData.get("model")
  const smallModel = formData.get("smallModel")
  const parsed = updateAgentSimpleFormSchema.safeParse({
    sandboxName: formData.get("sandboxName"),
    model: model === null ? undefined : model,
    smallModel: smallModel === null ? undefined : smallModel,
  })
  if (!parsed.success) {
    return invalidAgentFormState(parsed.error)
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
      sandboxName: parsed.data.sandboxName,
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

function invalidAgentFormState(error: z.ZodError): CreateAgentFormState {
  const { fieldErrors, formErrors } = error.flatten()
  const errors = Object.entries(fieldErrors).flatMap(([field, messages]) => {
    if (!Array.isArray(messages)) {
      return []
    }

    return messages.map((message) => ({
      field,
      message,
    }))
  })

  return {
    error: {
      code: "INVALID_FORM",
      message: formErrors[0] ?? "Agent configuration is invalid",
      errors: errors.length > 0 ? errors : undefined,
    },
  }
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
