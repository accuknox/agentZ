import type { OpencodePart, OpencodeToolPart, SessionMessagesResponse } from "@/lib/gateway/client"
import { parseToolPayload } from "./tool-payload"
import type { ChatMessage, ChatTextPart, ChatTool, ChatToolPart } from "./types"

export function chatHistoryToMessages(pages: SessionMessagesResponse[]): ChatMessage[] {
  return pages
    .flat()
    .toReversed()
    .flatMap((message) => messageToChatMessages(message.info, message.parts))
}

function messageToChatMessages(
  info: SessionMessagesResponse[number]["info"],
  parts: OpencodePart[]
): ChatMessage[] {
  const textParts = parts.flatMap(toTextPart)
  const toolParts = parts.flatMap(toToolPart)
  const content = textParts.map((part) => part.content).join("")

  if (info.role === "user") {
    return [
      {
        id: `${info.id}:user`,
        content,
        parts: textParts,
        requestID: requestID(info),
        role: "user",
        runID: info.id,
        status: "complete",
      },
    ]
  }

  return [
    {
      id: `${info.id}:assistant`,
      content,
      parts: [...textParts, ...toolParts],
      requestID: requestID(info),
      role: "assistant",
      runID: info.id,
      status: info.error ? "error" : "complete",
    },
  ]
}

function toTextPart(part: OpencodePart): ChatTextPart[] {
  if (part.type !== "text" || !part.text) {
    return []
  }

  return [{ id: part.id, content: part.text, type: "text" }]
}

function toToolPart(part: OpencodePart): ChatToolPart[] {
  if (part.type !== "tool") {
    return []
  }

  return [
    {
      id: part.id,
      tool: {
        id: part.callID,
        input: part.state.input,
        name: part.tool,
        output: toolOutput(part),
        state: toolState(part),
        errorText: part.state.status === "error" ? part.state.error : undefined,
      },
      type: "tool",
    },
  ]
}

function toolOutput(part: OpencodeToolPart): unknown {
  if (part.state.status !== "completed") {
    return undefined
  }

  return parseToolPayload(part.state.output)
}

function toolState(part: OpencodeToolPart): ChatTool["state"] {
  switch (part.state.status) {
    case "completed":
      return "output-available"
    case "error":
      return "output-error"
    default:
      return "input-available"
  }
}

function requestID(info: SessionMessagesResponse[number]["info"]): string {
  return "parentID" in info ? info.parentID : info.id
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
