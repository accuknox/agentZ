export type ChatMessageStatus = "complete" | "error" | "interrupted" | "streaming"

export type ChatMessage = {
  id: string
  content: string
  parts: ChatMessagePart[]
  requestID: string
  role: "assistant" | "user"
  runID: string
  status: ChatMessageStatus
}

export type ChatMessagePart = ChatTextPart | ChatToolPart

export type ChatTextPart = {
  id: string
  content: string
  type: "text"
}

export type ChatToolPart = {
  id: string
  tool: ChatTool
  type: "tool"
}

export type KnownToolName = "hostexec_exec_command" | "hostexec_write_stdin" | "web_fetch"

export type ChatToolState = "input-available" | "output-available" | "output-error"

export type ChatTool = {
  id: string
  errorText?: string
  input: unknown
  name: string
  output?: unknown
  state: ChatToolState
}
