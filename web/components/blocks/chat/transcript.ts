import type { SessionStreamEvent } from "@/lib/gateway/client"
import { getToolErrorText, getToolResultState, parseToolPayload } from "./tool-payload"
import type {
  AssistantDeltaEvent,
  ChatMessage,
  ChatMessagePart,
  ChatMessageStatus,
  ChatTextPart,
  ChatTool,
  ChatToolPart,
  ToolCallEvent,
  ToolResultEvent,
} from "./types"

export function reduceSessionEvent(
  messages: ChatMessage[],
  event: SessionStreamEvent
): ChatMessage[] {
  switch (event.type) {
    case "EVENT_TYPE_RUN_STARTED":
      return upsertMessage(messages, {
        id: userMessageID(event.request_id),
        content: event.content,
        parts: [{ id: `${event.request_id}:user:text`, content: event.content, type: "text" }],
        requestID: event.request_id,
        role: "user",
        runID: event.run_id,
        status: "complete",
      })
    case "EVENT_TYPE_ASSISTANT_DELTA":
      return appendAssistantDelta(messages, event)
    case "EVENT_TYPE_ASSISTANT_MESSAGE":
      return upsertAssistantMessage(messages, event, event.content, "complete")
    case "EVENT_TYPE_RUN_COMPLETED":
      return updateAssistantStatus(messages, event.request_id, "complete")
    case "EVENT_TYPE_RUN_INTERRUPTED":
      return upsertAssistantMessage(messages, event, event.content ?? "", "interrupted")
    case "EVENT_TYPE_RUN_ERROR":
      return upsertAssistantMessage(messages, event, event.error, "error")
    case "EVENT_TYPE_TOOL_CALL":
      return upsertToolCall(messages, event)
    case "EVENT_TYPE_TOOL_RESULT":
      return upsertToolResult(messages, event)
    case "EVENT_TYPE_UNSPECIFIED":
      return messages
  }
}

export function toLocalMessages(messages: string[]): ChatMessage[] {
  return messages.map((message, idx) => ({
    id: `local:${idx}`,
    content: message,
    parts: [{ id: `local:${idx}:text`, content: message, type: "text" }],
    requestID: `local:${idx}`,
    role: "user",
    runID: `local:${idx}`,
    status: "complete",
  }))
}

function appendAssistantDelta(messages: ChatMessage[], event: AssistantDeltaEvent): ChatMessage[] {
  const chunk = event.content ?? event.reasoning_content ?? ""
  if (!chunk) {
    return messages
  }

  const message = findAssistantMessage(messages, event.request_id)
  const content = `${message?.content ?? ""}${chunk}`
  const parts = appendTextPart(message?.parts ?? [], chunk)

  return upsertAssistantMessage(messages, event, content, "streaming", parts)
}

function upsertAssistantMessage(
  messages: ChatMessage[],
  event: SessionStreamEvent,
  content: string,
  status: ChatMessageStatus,
  parts?: ChatMessagePart[]
): ChatMessage[] {
  const message = findAssistantMessage(messages, event.request_id)
  const nextParts = parts ?? message?.parts ?? textParts(event.request_id, content)

  return upsertMessage(messages, {
    id: assistantMessageID(event.request_id),
    content,
    parts: nextParts.length > 0 ? nextParts : textParts(event.request_id, content),
    requestID: event.request_id,
    role: "assistant",
    runID: event.run_id,
    status,
  })
}

function updateAssistantStatus(
  messages: ChatMessage[],
  requestID: string,
  status: ChatMessageStatus
): ChatMessage[] {
  const message = findAssistantMessage(messages, requestID)
  if (!message) {
    return messages
  }

  return upsertMessage(messages, { ...message, status })
}

function upsertToolCall(messages: ChatMessage[], event: ToolCallEvent): ChatMessage[] {
  return upsertAssistantTool(messages, event, {
    id: toolID(event),
    input: parseToolPayload(event.tool_payload),
    name: event.tool_name,
    state: "input-available",
  })
}

function upsertToolResult(messages: ChatMessage[], event: ToolResultEvent): ChatMessage[] {
  const existing = findToolPart(messages, event.request_id, toolID(event))?.tool
  const output = parseToolPayload(event.tool_payload)

  return upsertAssistantTool(messages, event, {
    id: toolID(event),
    input: existing?.input,
    name: event.tool_name,
    output,
    state: getToolResultState(output),
    errorText: getToolErrorText(output),
  })
}

function upsertAssistantTool(
  messages: ChatMessage[],
  event: SessionStreamEvent,
  tool: ChatTool
): ChatMessage[] {
  const message = findAssistantMessage(messages, event.request_id) ?? emptyAssistantMessage(event)

  return upsertMessage(messages, {
    ...message,
    parts: upsertToolPart(message.parts, tool),
  })
}

function appendTextPart(parts: ChatMessagePart[], content: string): ChatMessagePart[] {
  const last = parts.at(-1)
  if (!last || last.type !== "text") {
    return [...parts, { id: `text:${parts.length}`, content, type: "text" }]
  }

  return parts.map((part, index) => {
    if (index !== parts.length - 1 || part.type !== "text") {
      return part
    }

    return { ...part, content: `${part.content}${content}` }
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

function findToolPart(
  messages: ChatMessage[],
  requestID: string,
  id: string
): ChatToolPart | undefined {
  return findAssistantMessage(messages, requestID)?.parts.find((part): part is ChatToolPart => {
    return part.type === "tool" && part.tool.id === id
  })
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

function emptyAssistantMessage(event: SessionStreamEvent): ChatMessage {
  return {
    id: assistantMessageID(event.request_id),
    content: "",
    parts: [],
    requestID: event.request_id,
    role: "assistant",
    runID: event.run_id,
    status: "streaming",
  }
}

function textParts(requestID: string, content: string): ChatTextPart[] {
  if (!content) {
    return []
  }

  return [{ id: `${requestID}:assistant:text`, content, type: "text" }]
}

function assistantMessageID(requestID: string): string {
  return `${requestID}:assistant`
}

function userMessageID(requestID: string): string {
  return `${requestID}:user`
}

function toolID(event: ToolCallEvent | ToolResultEvent): string {
  return `${event.request_id}:${event.tool_name}`
}
