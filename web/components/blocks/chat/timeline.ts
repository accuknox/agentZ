import type {
  AssistantMessage,
  Message,
  Part,
  SnapshotFileDiff,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { attachmentFromPart, type ChatAttachment } from "@/components/blocks/chat/attachments"
import { type OptimisticUserMessage } from "@/components/blocks/chat/use-opencode-chat"
import { describeMessageError } from "@/components/blocks/chat/errors"

export type RenderEntry =
  | { content: string; key: string; type: "text" }
  | { content: string; key: string; type: "reasoning" }
  | { key: string; toolEntries: ToolEntry[]; type: "tool" }

export type TimelineRow =
  | { key: string; message: OptimisticUserMessage; type: "local" }
  | {
      attachments: ChatAttachment[]
      createdAt: number
      key: string
      messageID: string
      text: string
      type: "user"
    }
  | { createdAt: number; entries: RenderEntry[]; key: string; type: "assistant" }
  // "Thinking..." placeholder rendered while the active turn has no content yet.
  | { key: string; type: "thinking" }
  | { body?: string; diffs: SnapshotFileDiff[]; key: string; title?: string; type: "diff-summary" }
  | { key: string; type: "checkpoint"; variant: "compaction" | "interrupted" }
  | { body: string; key: string; label: string; type: "assistant-error" }

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
  isBusy: boolean
  isRetrying: boolean
  localMessages: OptimisticUserMessage[]
  messages: Message[]
  partsByMessage: Record<string, Part[]>
  // User turns at or after this id are rolled back: hidden from the transcript
  // and shown in the revert dock instead.
  revertMessageID?: string
  textByPart: Record<string, string>
}

type RevertedMessage = { id: string; text: string }

// Assistant messages replying to one user turn merge until an interruption,
// which stays at the exact boundary where execution stopped.
function projectTurn(input: {
  assistants: AssistantMessage[]
  compacted: boolean
  out: TimelineRow[]
  partsByMessage: Record<string, Part[]>
  textByPart: Record<string, string>
  turnKey: string
  userIsLast: boolean
  isBusy: boolean
}): void {
  const { assistants, compacted, out, partsByMessage, textByPart, turnKey, userIsLast, isBusy } =
    input

  const interruption = compacted
    ? undefined
    : assistants.find((assistant) => assistant.error?.name === "MessageAbortedError")
  let entries: RenderEntry[] = []
  let createdAt = 0
  let segment = 0
  let hasContent = false
  let error: ReturnType<typeof describeMessageError> | undefined

  for (const assistant of assistants) {
    if (entries.length === 0) createdAt = assistant.time.created
    entries.push(...renderParts(partsByMessage[assistant.id] ?? [], textByPart))

    if (assistant === interruption) {
      if (entries.length > 0) {
        out.push({
          createdAt,
          entries,
          key: `${turnKey}:${segment}`,
          type: "assistant",
        })
        hasContent = true
        entries = []
        segment += 1
      }
      out.push({
        key: `checkpoint:interrupted:${assistant.id}`,
        type: "checkpoint",
        variant: "interrupted",
      })
      continue
    }

    if (assistant.error && assistant.error.name !== "MessageAbortedError" && !error) {
      error = describeMessageError(assistant.error)
    }
  }

  const isActiveTurn = userIsLast && isBusy
  if (entries.length > 0) {
    out.push({
      createdAt,
      entries,
      key: interruption ? `${turnKey}:${segment}` : turnKey,
      type: "assistant",
    })
    hasContent = true
  }

  if (!hasContent && isActiveTurn) {
    out.push({ key: `thinking:${turnKey}`, type: "thinking" })
  }

  if (error) {
    out.push({
      body: error.body,
      key: `assistant-error:${assistants.at(-1)?.id ?? "x"}`,
      label: error.label,
      type: "assistant-error",
    })
  }
}

export function projectTimeline(input: ProjectInput): {
  reverted: RevertedMessage[]
  rows: TimelineRow[]
} {
  const out: TimelineRow[] = []

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

  const localByID = new Map(input.localMessages.map((message) => [message.id, message]))
  const timeline: {
    createdAt: number
    key: string
    local?: OptimisticUserMessage
    turn?: (typeof turns)[number]
  }[] = visible.map((turn) => {
    const local = localByID.get(turn.user.id)
    localByID.delete(turn.user.id)
    return {
      createdAt: turn.user.time.created,
      key: turn.user.id,
      local,
      turn,
    }
  })
  for (const local of localByID.values()) {
    timeline.push({
      createdAt: local.createdAt,
      key: local.id,
      local,
      turn: undefined,
    })
  }
  timeline.sort((x, y) => x.createdAt - y.createdAt || x.key.localeCompare(y.key))

  const lastIndex = timeline.length - 1
  timeline.forEach((item, index) => {
    if (!item.turn) {
      if (item.local) {
        out.push({ key: item.local.id, message: item.local, type: "local" })
      }
      return
    }

    const turn = item.turn
    const userParts = input.partsByMessage[turn.user.id] ?? []
    const attachments = userParts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .flatMap((part) => {
        const attachment = attachmentFromPart(part)
        return attachment ? [attachment] : []
      })
    const compacted = userParts.some((part) => part.type === "compaction")

    if (item.local) {
      out.push({ key: item.local.id, message: item.local, type: "local" })
    } else {
      out.push({
        attachments,
        createdAt: turn.user.time.created,
        key: `user:${turn.user.id}`,
        messageID: turn.user.id,
        text: userText(turn.user.id),
        type: "user",
      })
    }

    if (compacted) {
      out.push({
        key: `checkpoint:compaction:${turn.user.id}`,
        type: "checkpoint",
        variant: "compaction",
      })
    }

    projectTurn({
      assistants: turn.assistants,
      compacted,
      isBusy: input.isBusy && !input.isRetrying,
      out,
      partsByMessage: input.partsByMessage,
      textByPart: input.textByPart,
      turnKey: `assistant:${turn.user.id}`,
      userIsLast: index === lastIndex,
    })

    // Only completed turns: on the active turn the snapshot lands mid-stream
    // and would flicker.
    const diffs = turn.user.summary?.diffs ?? []
    if (diffs.length > 0 && (index !== lastIndex || !input.isBusy)) {
      out.push({
        body: turn.user.summary?.body,
        diffs,
        key: `diff:${turn.user.id}`,
        title: turn.user.summary?.title,
        type: "diff-summary",
      })
    }
  })

  return { reverted, rows: out }
}
