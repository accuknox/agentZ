"use server"

import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type { DeleteSessionFormState, ListAgentProvidersActionResponse } from "@/data/types"
import { listAgentProvidersQuery, listAgentSessionsQuery } from "@/data/opencode.queries"

// listAgentSessionsAction loads OpenCode sessions for a single agent.
export async function listAgentSessionsAction(agentName: string) {
  return listAgentSessionsQuery(agentName)
}

// deleteAgentSessionAction deletes one OpenCode session for a single agent.
export async function deleteAgentSessionAction(
  agentName: string,
  _: DeleteSessionFormState,
  formData: FormData
): Promise<DeleteSessionFormState> {
  const sessionID = formData.get("sessionID")
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid session ID",
      },
      success: false,
    }
  }

  try {
    const client = createAgentOpencodeClient(agentName)
    const result = await client.session.delete({
      path: { id: sessionID },
    })

    if (!result.data) {
      return {
        error: {
          code: "OPENCODE_SESSION_DELETE_ERROR",
          message: "Failed to delete session",
        },
        success: false,
      }
    }

    return {
      error: undefined,
      success: true,
    }
  } catch (err) {
    return {
      error: {
        code: "OPENCODE_SESSION_DELETE_ERROR",
        message: err instanceof Error ? err.message : "Failed to delete session",
      },
      success: false,
    }
  }
}

// listAgentProvidersAction fetches available AI providers and their models for one agent.
export async function listAgentProvidersAction(
  agentName: string
): Promise<ListAgentProvidersActionResponse> {
  return listAgentProvidersQuery(agentName)
}
