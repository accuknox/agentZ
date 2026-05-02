import type { ChatHistoryResponse, StoredSessionEvent, ToolCall } from "@/lib/gateway/client"
import { getToolErrorText, getToolResultState, parseToolPayload } from "./tool-payload"
import type { ChatMessage, ChatMessagePart, ChatTool, ChatToolPart } from "./types"

type HistoryToolCall = {
  input: unknown
  name: string
  toolID: string
}

type HistoryReducerState = {
  messages: ChatMessage[]
  toolCalls: Map<string, HistoryToolCall>
}

export function chatHistoryToMessages(pages: ChatHistoryResponse[]): ChatMessage[] {
  const events = pages.flatMap((page) => page.events).toSorted((a, b) => a.seq - b.seq)

  const state = events.reduce<HistoryReducerState>(
    (next, event) => reduceStoredEvent(next, event),
    { messages: [], toolCalls: new Map() }
  )

  return state.messages
}

function reduceStoredEvent(
  state: HistoryReducerState,
  event: StoredSessionEvent
): HistoryReducerState {
  const requestID = event.payload.requestID
  if (!requestID) {
    return state
  }

  const choice = event.payload.choices?.[0]
  const message = choice?.message
  if (message?.role === "user") {
    return {
      ...state,
      messages: upsertMessage(state.messages, {
        id: `${requestID}:user`,
        content: message.content ?? "",
        parts: textParts(`${requestID}:user`, message.content ?? ""),
        requestID,
        role: "user",
        runID: event.payload.invocationId,
        status: "complete",
      }),
    }
  }

  if (message?.role === "assistant") {
    const toolCalls = message.tool_calls ?? []
    if (toolCalls.length > 0) {
      return reduceToolCalls(state, event, requestID, toolCalls)
    }

    return upsertAssistantText(state, event, requestID, message.content ?? "")
  }

  if (message?.role === "tool") {
    return reduceToolResult(state, event, requestID)
  }

  if (event.payload.object === "runner.completion") {
    return {
      ...state,
      messages: updateAssistantStatus(state.messages, requestID, "complete"),
    }
  }

  if (event.payload.object === "error" || event.payload.error) {
    return upsertAssistantText(
      state,
      event,
      requestID,
      event.payload.error?.message ?? "Agent run failed",
      "error"
    )
  }

  return state
}

function reduceToolCalls(
  state: HistoryReducerState,
  event: StoredSessionEvent,
  requestID: string,
  toolCalls: ToolCall[]
): HistoryReducerState {
  const nextToolCalls = new Map(state.toolCalls)
  let messages = state.messages

  for (const call of toolCalls) {
    const name = call.function?.name
    if (!name) {
      continue
    }

    const toolID = call.id ?? `${requestID}:${name}`
    const input = parseToolPayload(call.function?.arguments ?? "")
    nextToolCalls.set(toolID, { input, name, toolID })
    messages = upsertAssistantTool(messages, event, requestID, {
      id: toolID,
      input,
      name,
      state: "input-available",
    })
  }

  return { messages, toolCalls: nextToolCalls }
}

function reduceToolResult(
  state: HistoryReducerState,
  event: StoredSessionEvent,
  requestID: string
): HistoryReducerState {
  const message = event.payload.choices?.[0]?.message
  const toolID = message?.tool_id ?? `${requestID}:${message?.tool_name ?? "tool"}`
  const existing = state.toolCalls.get(toolID)
  const output = parseToolPayload(message?.content ?? "")
  const name = existing?.name ?? message?.tool_name ?? "tool"

  return {
    ...state,
    messages: upsertAssistantTool(state.messages, event, requestID, {
      id: toolID,
      input: existing?.input,
      name,
      output,
      state: getToolResultState(output),
      errorText: getToolErrorText(output),
    }),
  }
}

function upsertAssistantText(
  state: HistoryReducerState,
  event: StoredSessionEvent,
  requestID: string,
  content: string,
  status: ChatMessage["status"] = "complete"
): HistoryReducerState {
  const existing = findAssistantMessage(state.messages, requestID)
  const parts = content
    ? upsertTextPart(existing?.parts ?? [], requestID, content)
    : (existing?.parts ?? [])

  return {
    ...state,
    messages: upsertMessage(state.messages, {
      id: `${requestID}:assistant`,
      content,
      parts,
      requestID,
      role: "assistant",
      runID: event.payload.invocationId,
      status,
    }),
  }
}

function upsertAssistantTool(
  messages: ChatMessage[],
  event: StoredSessionEvent,
  requestID: string,
  tool: ChatTool
): ChatMessage[] {
  const message = findAssistantMessage(messages, requestID) ?? {
    id: `${requestID}:assistant`,
    content: "",
    parts: [],
    requestID,
    role: "assistant" as const,
    runID: event.payload.invocationId,
    status: "complete" as const,
  }

  return upsertMessage(messages, {
    ...message,
    parts: upsertToolPart(message.parts, tool),
  })
}

function upsertTextPart(
  parts: ChatMessagePart[],
  requestID: string,
  content: string
): ChatMessagePart[] {
  const id = `${requestID}:assistant:text`
  const idx = parts.findIndex((part) => part.type === "text" && part.id === id)
  if (idx === -1) {
    return [...parts, { id, content, type: "text" }]
  }

  return parts.map((part, index) => {
    if (index !== idx || part.type !== "text") {
      return part
    }

    return { ...part, content }
  })
}

function upsertToolPart(parts: ChatMessagePart[], tool: ChatTool): ChatMessagePart[] {
  const idx = parts.findIndex((part) => part.type === "tool" && part.tool.id === tool.id)
  if (idx === -1) {
    return [...parts, { id: tool.id, tool, type: "tool" }]
  }

  return parts.map((part, index) => {
    if (index !== idx || part.type !== "tool") {
      return part
    }

    return { ...part, tool: { ...part.tool, ...tool } }
  })
}

function updateAssistantStatus(
  messages: ChatMessage[],
  requestID: string,
  status: ChatMessage["status"]
): ChatMessage[] {
  const message = findAssistantMessage(messages, requestID)
  if (!message) {
    return messages
  }

  return upsertMessage(messages, { ...message, status })
}

function textParts(id: string, content: string): ChatMessagePart[] {
  if (!content) {
    return []
  }

  return [{ id: `${id}:text`, content, type: "text" }]
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((message) => message.id === next.id)
  if (idx === -1) {
    return [...messages, next]
  }

  return messages.map((message, index) => (index === idx ? next : message))
}

function findAssistantMessage(messages: ChatMessage[], requestID: string): ChatMessage | undefined {
  return messages.find((message) => message.requestID === requestID && message.role === "assistant")
}

export function mergeChatMessages(...groups: ChatMessage[][]): ChatMessage[] {
  const messages = new Map<string, ChatMessage>()
  for (const group of groups) {
    for (const message of group) {
      messages.set(message.id, message)
    }
  }

  return [...messages.values()]
}
