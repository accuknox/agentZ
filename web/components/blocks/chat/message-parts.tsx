import { MessageResponse } from "@/components/ai-elements/message"
import type { ReactNode } from "react"
import { ToolActivity } from "./tool-activity"
import type { ChatMessagePart } from "./types"

export function MessagePart({ part }: { part: ChatMessagePart }): ReactNode {
  switch (part.type) {
    case "text":
      return part.content ? <MessageResponse>{part.content}</MessageResponse> : null
    case "tool":
      return <ToolActivity tool={part.tool} />
  }
}
