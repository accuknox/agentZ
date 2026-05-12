"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import {
  createAgent,
  deleteAgent,
  sessionMessages,
  updateAgent,
  type Error,
} from "@/lib/gateway/client"
import type {
  ChatHistoryActionResponse,
  CreateAgentFormState,
  DeleteAgentFormState,
} from "@/data/types"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import { agentsTag } from "@/data/cache"

type ChatHistoryQuery = {
  agentName: string
  before?: string
  limit?: number
}

export async function getChatHistoryAction(
  query: ChatHistoryQuery
): Promise<ChatHistoryActionResponse> {
  const result = await sessionMessages({
    path: {
      agentName: query.agentName,
      sessionID: query.agentName,
    },
    query: {
      limit: query.limit,
      before: query.before,
    },
    cache: "no-store",
  })
  if (result.error) {
    return { data: undefined, error: toGatewayError(result.error) }
  }

  return { data: result.data, error: undefined }
}

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

function toGatewayError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return {
      code: "OPENCODE_ERROR",
      message: error.data.message,
    }
  }

  return {
    code: "OPENCODE_ERROR",
    message: "Request failed",
  }
}
