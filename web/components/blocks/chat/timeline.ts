import type { AttachmentData } from "@/components/ai-elements/attachments"
import type {
  AssistantMessage,
  Message,
  Part,
  SessionStatus,
  SnapshotFileDiff,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { attachmentDataFromPart } from "@/components/blocks/chat/attachments"
import { type LocalChatMessage } from "@/components/blocks/chat/use-opencode-chat"
import { unwrapMessageError } from "@/components/blocks/chat/errors"

export type RenderEntry =
  | { content: string; key: string; type: "text" }
  | { content: string; key: string; type: "reasoning" }
  | { key: string; toolEntries: ToolEntry[]; type: "tool" }

export type TimelineRow =
  | { key: string; message: LocalChatMessage; type: "local" }
  | {
      attachments: AttachmentData[]
      createdAt: number
      key: string
      messageID: string
      text: string
      type: "user"
    }
  | { createdAt: number; entries: RenderEntry[]; key: string; type: "assistant" }
  // "Thinking..." placeholder rendered while the active turn has no content yet.
  | { key: string; type: "thinking" }
  | { attempt: number; key: string; message: string; next: number; type: "retry" }
  | { body?: string; diffs: SnapshotFileDiff[]; key: string; title?: string; type: "diff-summary" }
  | { key: string; type: "divider"; variant: "compaction" | "interrupted" }
  | { body: string; key: string; kind: "history" | "stream"; label: string; type: "error" }
  | { body: string; key: string; label: string; type: "assistant-error" }

const MAX_RENDER_BLOCKS = 25
const contextToolNames = new Set(["read", "list", "glob", "grep"])

export type ToolEntry = { part: ToolPart; type: "tool" } | { parts: ToolPart[]; type: "context" }

function isVisibleTool(part: ToolPart): boolean {
  if (part.tool === "todowrite") return false
  if (part.tool === "question") {
    return part.state.status !== "pending" && part.state.status !== "running"
  }
  return true
}

function groupTools(parts: ToolPart[]): ToolEntry[] {
  const result: ToolEntry[] = []
  let group: ToolPart[] = []

  const flush = () => {
    if (group.length === 0) return
    if (group.length === 1) {
      const [part] = group
      if (part) result.push({ type: "tool", part })
    } else {
      result.push({ type: "context", parts: group })
    }
    group = []
  }

  for (const part of parts.filter(isVisibleTool)) {
    if (contextToolNames.has(part.tool)) {
      group.push(part)
      continue
    }
    flush()
    result.push({ type: "tool", part })
  }

  flush()
  return result
}

function renderParts(parts: Part[], textByPart: Record<string, string>): RenderEntry[] {
  const entries: RenderEntry[] = []
  let textBuffer: string[] = []
  let textKeys: string[] = []
  let toolBuffer: ToolPart[] = []

  function flushText() {
    const content = textBuffer.join("")
    if (content.length > 0) {
      entries.push({ content, key: textKeys.join(":"), type: "text" })
    }
    textBuffer = []
    textKeys = []
  }

  function flushTools() {
    if (toolBuffer.length === 0) return
    for (const entry of groupTools(toolBuffer)) {
      if (entry.type === "tool") {
        entries.push({ key: entry.part.id, toolEntries: [entry], type: "tool" })
      } else {
        entries.push({
          key: entry.parts.map((part) => part.id).join(":"),
          toolEntries: [entry],
          type: "tool",
        })
      }
    }
    toolBuffer = []
  }

  for (const part of parts) {
    if (part.type === "text") {
      if (part.synthetic) continue
      const content = textByPart[part.id] ?? part.text
      if (content.trim().length === 0) continue
      flushTools()
      textBuffer.push(content)
      textKeys.push(part.id)
      continue
    }

    if (part.type === "reasoning") {
      const content = textByPart[part.id] ?? part.text
      if (content.trim().length === 0) continue
      flushText()
      flushTools()
      entries.push({ content, key: part.id, type: "reasoning" })
      continue
    }

    if (part.type === "tool") {
      flushText()
      toolBuffer.push(part)
      continue
    }

    // Snapshot, patch, step markers, agent and retry parts surface through
    // other rows or are intentionally omitted.
    flushText()
    flushTools()
  }

  flushText()
  flushTools()
  return entries
}

type ProjectInput = {
  historyError?: string
  isBusy: boolean
  localMessages: LocalChatMessage[]
  messages: Message[]
  partsByMessage: Record<string, Part[]>
  // User turns at or after this id are rolled back: hidden from the transcript
  // and shown in the revert dock instead.
  revertMessageID?: string
  sessionStatus?: SessionStatus
  streamError?: string
  textByPart: Record<string, string>
}

export type RevertedMessage = { id: string; text: string }

// Assistant messages replying to one user turn merge into a single row so
// streaming deltas stay co-located; compaction and errors emit their own rows.
function projectTurn(input: {
  assistants: AssistantMessage[]
  out: TimelineRow[]
  partsByMessage: Record<string, Part[]>
  textByPart: Record<string, string>
  userIsLast: boolean
  isBusy: boolean
}): void {
  const { assistants, out, partsByMessage, textByPart, userIsLast, isBusy } = input

  const mergedEntries: RenderEntry[] = []
  const messageIDs: string[] = []
  let sawCompaction = false
  let lastError: ReturnType<typeof unwrapMessageError> | undefined

  for (const assistant of assistants) {
    const parts = partsByMessage[assistant.id] ?? []
    for (const part of parts) {
      if (part.type === "compaction") {
        sawCompaction = true
      }
    }
    mergedEntries.push(...renderParts(parts, textByPart))
    messageIDs.push(assistant.id)
    if (assistant.error) {
      lastError = unwrapMessageError(assistant.error)
    }
  }

  if (sawCompaction) {
    out.push({
      key: `divider:compaction:${assistants[0]?.id ?? messageIDs.join(":")}`,
      type: "divider",
      variant: "compaction",
    })
  }

  const isActiveTurn = userIsLast && isBusy
  const hasContent = mergedEntries.length > 0

  if (hasContent) {
    out.push({
      createdAt: assistants[0]?.time.created ?? 0,
      entries: mergedEntries,
      key: `assistant:${messageIDs.join(":")}`,
      type: "assistant",
    })
  } else if (isActiveTurn) {
    out.push({ key: `thinking:${messageIDs.join(":")}`, type: "thinking" })
  }

  if (lastError) {
    if (lastError.interrupted) {
      out.push({
        key: `divider:interrupted:${assistants.at(-1)?.id ?? "x"}`,
        type: "divider",
        variant: "interrupted",
      })
    } else {
      out.push({
        body: lastError.body,
        key: `assistant-error:${assistants.at(-1)?.id ?? "x"}`,
        label: lastError.label,
        type: "assistant-error",
      })
    }
  }
}

export function projectTimeline(input: ProjectInput): {
  reverted: RevertedMessage[]
  rows: TimelineRow[]
} {
  const out: TimelineRow[] = []

  // Optimistic local messages render first, bridging submit to server ack.
  for (const message of input.localMessages) {
    out.push({ key: message.id, message, type: "local" })
  }

  const userText = (messageID: string) =>
    (input.partsByMessage[messageID] ?? [])
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .filter((part) => part.synthetic !== true)
      .map((part) => input.textByPart[part.id] ?? part.text)
      .join("")

  // Group the server messages into turns by parentID so rendering does not
  // depend on assistants staying adjacent to their user prompt.
  const turns: { assistants: AssistantMessage[]; user: UserMessage }[] = []
  const turnsByUserID = new Map<string, (typeof turns)[number]>()
  for (const message of input.messages) {
    if (message.role === "user") {
      const turn = { assistants: [], user: message }
      turns.push(turn)
      turnsByUserID.set(message.id, turn)
      continue
    }
    const turn = turnsByUserID.get(message.parentID)
    if (turn) {
      turn.assistants.push(message)
    }
  }

  // Message ids are monotonic, so a revert point cleaves the transcript: every
  // turn at or after it is rolled back and belongs to the dock, not the rows.
  const reverted: RevertedMessage[] = []
  const visible = turns.filter((turn) => {
    if (input.revertMessageID && turn.user.id >= input.revertMessageID) {
      reverted.push({ id: turn.user.id, text: userText(turn.user.id) })
      return false
    }
    return true
  })

  const lastIndex = visible.length - 1
  visible.forEach((turn, index) => {
    const attachments = (input.partsByMessage[turn.user.id] ?? [])
      .filter((part): part is Extract<Part, { type: "file" }> => part.type === "file")
      .map(attachmentDataFromPart)

    out.push({
      attachments,
      createdAt: turn.user.time.created,
      key: `user:${turn.user.id}`,
      messageID: turn.user.id,
      text: userText(turn.user.id),
      type: "user",
    })

    projectTurn({
      assistants: turn.assistants,
      isBusy: input.isBusy,
      out,
      partsByMessage: input.partsByMessage,
      textByPart: input.textByPart,
      userIsLast: index === lastIndex,
    })

    // Only completed turns: on the active turn the snapshot lands mid-stream
    // and would flicker.
    const diffs = turn.user.summary?.diffs ?? []
    if (diffs.length > 0 && index !== lastIndex) {
      out.push({
        body: turn.user.summary?.body,
        diffs,
        key: `diff:${turn.user.id}`,
        title: turn.user.summary?.title,
        type: "diff-summary",
      })
    }
  })

  // Retry row takes priority over the Thinking placeholder; the session is
  // waiting to re-attempt the same turn rather than producing content.
  if (input.sessionStatus?.type === "retry") {
    out.push({
      attempt: input.sessionStatus.attempt,
      key: `retry:${input.sessionStatus.attempt}`,
      message: input.sessionStatus.message,
      next: input.sessionStatus.next,
      type: "retry",
    })
  }

  // History failures sit at the top so they show on empty timelines; stream
  // failures sit at the bottom, next to the in-flight turn they invalidate.
  if (input.historyError) {
    out.unshift({
      body: input.historyError,
      key: "history-error",
      kind: "history",
      label: "Failed to load history",
      type: "error",
    })
  }
  if (input.streamError) {
    out.push({
      body: input.streamError,
      key: "stream-error",
      kind: "stream",
      label: "Live session disconnected",
      type: "error",
    })
  }

  // Cap to recent blocks so huge sessions don't render the whole transcript.
  const rows = out.length > MAX_RENDER_BLOCKS ? out.slice(out.length - MAX_RENDER_BLOCKS) : out
  return { reverted, rows }
}
