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

// A render entry is one piece of assistant content within an assistant row.
// Tools that are "context" reads (read/list/glob/grep) collapse into a single
// tool-group entry so the timeline stays compact, mirroring opencode's
// ContextToolGroup. Checkpoint/compaction parts are NOT included here — they
// surface as standalone divider rows (see TimelineRow).
export type RenderEntry =
  | { content: string; key: string; type: "text" }
  | { content: string; key: string; type: "reasoning" }
  | { key: string; toolEntries: ToolEntry[]; type: "tool" }

export type TimelineRow =
  // Local optimistic/system message that hasn't been replaced by the server yet.
  | { key: string; message: LocalChatMessage; type: "local" }
  | { attachments: AttachmentData[]; key: string; text: string; type: "user" }
  // One or more consecutive assistant messages merged into a single block.
  // `messageIDs` preserves the source order so stable keys survive streaming.
  | {
      entries: RenderEntry[]
      key: string
      type: "assistant"
    }
  // "Thinking…" placeholder rendered while the active turn has no content yet.
  | { key: string; type: "thinking" }
  // Provider-side retry with a countdown — from SessionStatus.type === "retry".
  | {
      attempt: number
      key: string
      message: string
      next: number
      type: "retry"
    }
  // Collapsible diff summary emitted after a completed user turn that edited files.
  | {
      body?: string
      diffs: SnapshotFileDiff[]
      key: string
      title?: string
      type: "diff-summary"
    }
  // Visual seam: "Context compacted" (auto/manual) or "Interrupted" (aborted).
  | { key: string; type: "divider"; variant: "compaction" | "interrupted" }
  // Surface-level error row (stream reconnect failure or history load failure).
  // `kind` lets the renderer wire up the right retry affordance.
  | {
      body: string
      key: string
      kind: "history" | "stream"
      label: string
      type: "error"
    }
  // Assistant-message-level error (after an aborted/failed turn).
  | {
      body: string
      key: string
      label: string
      type: "assistant-error"
    }

const MAX_RENDER_BLOCKS = 25
const contextToolNames = new Set(["read", "list", "glob", "grep"])

type ToolEntry = { part: ToolPart; type: "tool" } | { parts: ToolPart[]; type: "context" }

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

// Orders and groups the parts of ONE assistant message into render entries.
// Text deltas accumulate into a single text entry; consecutive tools merge into
// tool groups; reasoning is emitted inline so it interleaves with messages.
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
      if ("synthetic" in part && part.synthetic === true) continue
      const content = textByPart[part.id] ?? part.text
      if (content.length === 0) continue
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

    // snapshot/patch/subtask/stepStart/stepFinish/agent/retry are not surfaced
    // as inline entries; their effects land through other rows (divider,
    // retry, diff-summary) or are noise the timeline intentionally omits.
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
  // Map<messageID, Part[]>
  partsByMessage: Record<string, Part[]>
  sessionStatus?: SessionStatus
  streamError?: string
  textByPart: Record<string, string>
}

// Walk one user message + the consecutive assistant messages that reply to it
// and append timeline rows. The assistant messages are merged into a single
// `assistant` row so streaming deltas stay co-located; compaction parts and
// message-level errors emit their own rows immediately after.
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

export function projectTimeline(input: ProjectInput): TimelineRow[] {
  const out: TimelineRow[] = []

  // localMessages always render first in chronological order — optimistic
  // user messages connect the prompt submit to the eventual server ack.
  for (const message of input.localMessages) {
    out.push({ key: message.id, message, type: "local" })
  }

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

  const lastIndex = turns.length - 1
  turns.forEach((turn, index) => {
    const attachments = (input.partsByMessage[turn.user.id] ?? [])
      .filter((part): part is Extract<Part, { type: "file" }> => part.type === "file")
      .map(attachmentDataFromPart)
    const text = (input.partsByMessage[turn.user.id] ?? [])
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .filter((part) => part.synthetic !== true)
      .map((part) => input.textByPart[part.id] ?? part.text)
      .join("")

    out.push({ attachments, key: `user:${turn.user.id}`, text, type: "user" })

    projectTurn({
      assistants: turn.assistants,
      isBusy: input.isBusy,
      out,
      partsByMessage: input.partsByMessage,
      textByPart: input.textByPart,
      userIsLast: index === lastIndex,
    })

    // Diff summary only matters for completed turns — wiring it on the active
    // turn would flicker as the snapshot lands mid-stream.
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

  // History-load failures are sticky at the top — so the user sees them even
  // on otherwise-empty timelines. Stream failures ride at the bottom because
  // they invalidate the latest assistant turn in flight.
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

  // Cap to the most recent blocks so a 1000-message session never renders
  // the entire transcript (matches the existing UX). Slice on the merged
  // rows so we don't drop a trailing thinking/retry/error row solo.
  if (out.length > MAX_RENDER_BLOCKS) {
    return out.slice(out.length - MAX_RENDER_BLOCKS)
  }
  return out
}
