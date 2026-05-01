"use server"

import { redirect } from "next/navigation"
import { createAgent, listAgents, type Agent, type ListAgent } from "@/lib/gateway/client"
import { createAgentFormSchema } from "@/data/schema"
import type {
  CreateAgentFormState,
  ListAgentActionResponse,
  ListAgentWithConfigActionResponse,
} from "@/data/types"
import { agentFormValues, createAgentRequest } from "@/data/utils"

export async function listAgentsAction(): Promise<ListAgentActionResponse>
export async function listAgentsAction(includeConfig: false): Promise<ListAgentActionResponse>
export async function listAgentsAction(
  includeConfig: true
): Promise<ListAgentWithConfigActionResponse>
export async function listAgentsAction(includeConfig = false) {
  const result = await listAgents()
  if (result.error) {
    return { agents: undefined, error: result.error }
  }

  const agents = result.data.agents.filter((agent) => agent.status !== "DELETED")
  if (includeConfig) {
    return { agents, error: undefined } satisfies ListAgentActionResponse<ListAgent>
  }

  return {
    agents: agents.map(({ configuration: _, ...agent }) => agent),
    error: undefined,
  } satisfies ListAgentActionResponse<Agent>
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
