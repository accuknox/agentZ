import type { Event, Session } from "@opencode-ai/sdk"
import type { AgentSessionListItem } from "@/data/types"

type SessionLifecycleEvent = Extract<
  Event,
  { type: "session.created" | "session.updated" | "session.deleted" }
>

// toAgentSessionListItem converts an OpenCode session into sidebar list data.
export function toAgentSessionListItem(session: Session): AgentSessionListItem {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.time.updated,
  }
}

// sortAgentSessions orders sessions by last update time, then by ID.
export function sortAgentSessions(
  sessions: readonly AgentSessionListItem[]
): AgentSessionListItem[] {
  return [...sessions].sort((x, y) => {
    return y.updatedAt - x.updatedAt || x.id.localeCompare(y.id)
  })
}

// isSessionLifecycleEvent narrows SSE payloads to sidebar-relevant changes.
export function isSessionLifecycleEvent(event: Event): event is SessionLifecycleEvent {
  return (
    event.type === "session.created" ||
    event.type === "session.updated" ||
    event.type === "session.deleted"
  )
}

// applySessionLifecycleEvent folds one session event into the sidebar list.
export function applySessionLifecycleEvent(
  sessions: readonly AgentSessionListItem[],
  event: SessionLifecycleEvent
): AgentSessionListItem[] {
  const next = new Map(sessions.map((session) => [session.id, session]))
  const session = toAgentSessionListItem(event.properties.info)

  if (event.type === "session.deleted") {
    next.delete(session.id)
    return sortAgentSessions(Array.from(next.values()))
  }

  next.set(session.id, session)
  return sortAgentSessions(Array.from(next.values()))
}
