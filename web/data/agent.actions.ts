"use server"

import { redirect } from "next/navigation"
import { createAgent, listAgents } from "@/lib/gateway/client"
import { createAgentFormSchema } from "@/data/schema"
import type { CreateAgentFormState, ListAgentActionResponse } from "@/data/types"
import { agentFormValues, createAgentRequest } from "@/data/utils"

export async function listAgentsAction(): Promise<ListAgentActionResponse> {
  const result = await listAgents()
  if (result.error) {
    return { agents: undefined, error: result.error }
  }
  return {
    agents: result.data.agents.filter((agent) => agent.status !== "DELETED"),
    error: undefined,
  }
}

export async function createAgentFormAction(
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = createAgentFormSchema.safeParse(agentFormValues(formData))
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Agent configuration is invalid",
        errors: parsed.error.issues.map((issue) => {
          return {
            field: issue.path.join("."),
            message: issue.message,
          }
        }),
      },
    }
  }

  const result = await createAgent({ body: createAgentRequest(parsed.data) })
  if (result.error) {
    return { error: result.error }
  }

  redirect("/")
}
