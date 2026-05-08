import type { ListAgentActionResponse } from "@/data/types"

export function selectedSessionID(result: ListAgentActionResponse, sessionID?: string) {
  if (result.error) {
    return undefined
  }

  return sessionID ?? result.agents[0]?.session_id
}
