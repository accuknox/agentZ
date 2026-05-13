import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type { ListAgentSessionActionResponse } from "@/data/types"
import { sortAgentSessions, toAgentSessionListItem } from "@/lib/opencode/session-list"

// listAgentSessionsQuery returns sidebar-ready OpenCode sessions for one agent.
export async function listAgentSessionsQuery(
  agentName: string
): Promise<ListAgentSessionActionResponse> {
  try {
    const client = createAgentOpencodeClient(agentName)
    const result = await client.session.list()
    const sessions = result.data

    if (!sessions) {
      return {
        sessions: undefined,
        error: {
          code: "OPENCODE_SESSION_LIST_ERROR",
          message: "Failed to load sessions",
        },
      }
    }

    return {
      sessions: sortAgentSessions(sessions.map(toAgentSessionListItem)),
      error: undefined,
    }
  } catch (err) {
    return {
      sessions: undefined,
      error: {
        code: "OPENCODE_SESSION_LIST_ERROR",
        message: err instanceof Error ? err.message : "Failed to load sessions",
      },
    }
  }
}
