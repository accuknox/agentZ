"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import {
  createAgent,
  deleteAgent,
  getChatHistory,
  updateAgent,
  type GetChatHistoryData,
} from "@/lib/gateway/client"
import type {
  ChatHistoryActionResponse,
  CreateAgentFormState,
  DeleteAgentFormState,
} from "@/data/types"
import { createAgentRequest, updateAgentRequest, parseAgentForm } from "@/data/utils"
import { agentsTag } from "@/data/cache"

export async function getChatHistoryAction(
  query: GetChatHistoryData["query"]
): Promise<ChatHistoryActionResponse> {
  const result = await getChatHistory({ query, cache: "no-store" })
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

  updateTag(agentsTag)
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

  updateTag(agentsTag)
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

  updateTag(agentsTag)
  redirect("/")
}
