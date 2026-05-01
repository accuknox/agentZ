"use server"

import { redirect } from "next/navigation"
import {
  createAgent,
  listAgents,
  updateAgent,
  type Agent,
  type ListAgentsData,
  type ListAgent,
} from "@/lib/gateway/client"
import type {
  CreateAgentFormState,
  ListAgentActionResponse,
  ListAgentWithConfigActionResponse,
} from "@/data/types"
import { createAgentRequest, updateAgentRequest, parseAgentForm } from "@/data/utils"
import { revalidatePath } from "next/cache"

export async function listAgentsAction(): Promise<ListAgentActionResponse>
export async function listAgentsAction(
  includeConfig: false,
  query?: ListAgentsData["query"]
): Promise<ListAgentActionResponse>
export async function listAgentsAction(
  includeConfig: true,
  query?: ListAgentsData["query"]
): Promise<ListAgentWithConfigActionResponse>
export async function listAgentsAction(includeConfig = false, query?: ListAgentsData["query"]) {
  const result = await listAgents({ query })
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
  const parsed = parseAgentForm(formData)
  if (parsed.state) {
    return parsed.state
  }

  const result = await createAgent({ body: createAgentRequest(parsed.data) })
  if (result.error) {
    return { error: result.error }
  }

  revalidatePath("/")
  redirect("/")
}

export async function updateAgentFormAction(
  sessionID: string,
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = parseAgentForm(formData)
  if (parsed.state) {
    return parsed.state
  }

  const result = await updateAgent({
    body: updateAgentRequest(parsed.data),
    path: { sessionID },
  })
  if (result.error) {
    return { error: result.error }
  }

  revalidatePath("/")
  redirect("/")
}
