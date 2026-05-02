"use server"

import { redirect } from "next/navigation"
import {
  createAgent,
  deleteAgent,
  getChatHistory,
  listAgents,
  updateAgent,
  type Agent,
  type GetChatHistoryData,
  type ListAgentsData,
  type ListAgent,
} from "@/lib/gateway/client"
import type {
  ChatHistoryActionResponse,
  CreateAgentFormState,
  DeleteAgentFormState,
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

export async function getChatHistoryAction(
  query: GetChatHistoryData["query"]
): Promise<ChatHistoryActionResponse> {
  const result = await getChatHistory({ query })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  return { data: result.data, error: undefined }
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

export async function deleteAgentFormAction(
  sessionID: string,
  _: DeleteAgentFormState,
  _formData: FormData
): Promise<DeleteAgentFormState> {
  const result = await deleteAgent({ body: { session_id: sessionID } })
  if (result.error) {
    return { error: result.error }
  }

  revalidatePath("/")
  return {}
}
