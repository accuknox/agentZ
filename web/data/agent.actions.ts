"use server"

import * as z from "zod"
import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import { createAgent, deleteAgent, updateAgent } from "@/lib/gateway/client"
import type { CreateAgentFormState, DeleteAgentFormState } from "@/data/types"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import { agentsTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function createAgentFormAction(
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = createAgentSimpleFormSchema.safeParse({
    ...Object.fromEntries(formData),
    skills: formData.getAll("skills"),
    memoryEnabled: formData.has("memoryEnabled"),
  })
  if (!parsed.success) {
    return invalidAgentFormState(parsed.error)
  }

  const result = await createAgent({
    body: {
      name: parsed.data.name,
      sandbox: { scope: "Organisation", name: parsed.data.sandboxName },
      skills: parsed.data.skills.map((name) => ({ scope: "Organisation", name })),
      memory: { enabled: parsed.data.memoryEnabled },
    },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  updateTag(skillsTag)
  redirect("/")
}

export async function updateAgentFormAction(
  agentName: string,
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = updateAgentSimpleFormSchema.safeParse({
    ...Object.fromEntries(formData),
    skills: formData.getAll("skills"),
    memoryEnabled: formData.has("memoryEnabled"),
  })
  if (!parsed.success) {
    return invalidAgentFormState(parsed.error)
  }

  const result = await updateAgent({
    body: {
      sandbox: { scope: "Organisation", name: parsed.data.sandboxName },
      skills: parsed.data.skills.map((name) => ({ scope: "Organisation", name })),
      memory: { enabled: parsed.data.memoryEnabled },
    },
    client: getGatewayServerClient(),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  updateTag(skillsTag)
  redirect("/")
}

function invalidAgentFormState(error: z.ZodError): CreateAgentFormState {
  const { formErrors } = error.flatten()
  const errors = error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }))

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
  updateTag(skillsTag)
  redirect("/")
}
