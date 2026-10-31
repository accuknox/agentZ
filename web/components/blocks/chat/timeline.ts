import type {
  AssistantMessage,
  Message,
  Part,
  FilePart,
  UserMessage,
  QuestionInfo,
  QuestionAnswer,
  ReasoningPart,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import { attachmentFromPart, type ChatAttachment } from "@/components/blocks/chat/attachments"
import { describeMessageError } from "@/components/blocks/chat/errors"
import { z } from "zod"

const inputIDSchema = z.uuid()

const messageActorSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(["user", "api_key", "system"]),
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict()

// Tool input and metadata are open JSON in the SDK. Read only the native
// question contract; never turn its raw output into transcript markup.
const questionResultSchema = z.object({
  input: z.object({ questions: z.array(z.object({ question: z.string() })) }),
  metadata: z.object({ answers: z.array(z.array(z.string())) }).optional(),
})

type MessageActor = z.infer<typeof messageActorSchema>

type MessageEntry =
  | { content: string; key: string; type: "text" }
  | { parts: (ReasoningPart | ToolPart)[]; key: string; type: "work" }
  | { files: FilePart[]; key: string; type: "attachments" }
  | {
      key: string
      type: "question"
      questions: Pick<QuestionInfo, "question">[]
      answers: QuestionAnswer[]
      dismissed: boolean
    }

export type TimelineRow =
  | {
      actor?: MessageActor
      attachments: ChatAttachment[]
      createdAt: number
      key: string
      messageID: string
      isWaiting: boolean
      text: string
      type: "user"
    }
  | {
      createdAt: number
      entries: MessageEntry[]
      isStreaming: boolean
      key: string
      type: "assistant"
    }
  | { key: string; type: "checkpoint"; variant: "compaction" | "interrupted" }
  | {
      body: string
      key: string
      label: string
      revertMessageID?: string
      type: "assistant-error"
      partialOutput: boolean
    }

function renderParts(
  parts: Part[],
  textByPart: Record<string, string>,
  showWork: boolean
): MessageEntry[] {
  const entries: MessageEntry[] = []
  let text: string[] = []
  let key = ""

  function flushText() {
    if (text.length > 0) {
      entries.push({ content: text.join(""), key, type: "text" })
      text = []
      key = ""
    }
  }

  for (const part of parts) {
    if (part.type === "text") {
      if (part.synthetic || part.ignored) continue
      const content = textByPart[part.id] ?? part.text
      if (!content.trim()) continue
      if (text.length === 0) key = part.id
      text.push(content)
      continue
    }

    flushText()
    if (
      showWork &&
      ((part.type === "reasoning" && part.text.trim().length > 0) ||
        (part.type === "tool" && !["report_progress", "question", "plan_exit"].includes(part.tool)))
    ) {
      const previous = entries.at(-1)
      const last = previous?.type === "work" ? previous.parts.at(-1) : undefined
      const failed = part.type === "tool" && part.state.status === "error"
      if (
        previous?.type === "work" &&
        !failed &&
        !(last?.type === "tool" && last.state.status === "error")
      ) {
        previous.parts.push(part)
      } else {
        entries.push({ type: "work", key: part.id, parts: [part] })
      }
    }
    if (part.type === "tool" && part.tool === "question") {
      const dismissed =
        part.state.status === "error" && part.state.error === "The user dismissed this question"
      if (part.state.status === "completed" || dismissed) {
        const result = questionResultSchema.safeParse(part.state)
        if (result.success && (dismissed || result.data.metadata)) {
          entries.push({
            type: "question",
            key: part.id,
            questions: result.data.input.questions,
            answers: result.data.metadata?.answers ?? [],
            dismissed,
          })
        }
      }
    }
    if (
      part.type === "tool" &&
      part.state.status === "completed" &&
      part.state.attachments?.length
    ) {
      entries.push({
        key: `attachments:${part.id}`,
        files: part.state.attachments,
        type: "attachments",
      })
    }
  }
  flushText()
  return entries
}

type ProjectInput = {
  showWork?: boolean
  isBusy: boolean
  isRetrying: boolean
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
  showWork: boolean
  assistants: AssistantMessage[]
  compacted: boolean
  out: TimelineRow[]
  partsByMessage: Record<string, Part[]>
  textByPart: Record<string, string>
  turnKey: string
  isActive: boolean
  messageID: string
  guardrailMessageID?: string
}): string | undefined {
  const { assistants, compacted, out, partsByMessage, textByPart, turnKey, isActive } = input

  const interruption = compacted
    ? undefined
    : assistants.find((assistant) => assistant.error?.name === "MessageAbortedError")
  let entries: MessageEntry[] = []
  let createdAt = 0
  let segment = 0
  let error: ReturnType<typeof describeMessageError> | undefined

  for (const assistant of assistants) {
    if (entries.length === 0) createdAt = assistant.time.created
    // Compaction summaries belong to the runtime context, not the conversation.
    const next = assistant.summary
      ? []
      : renderParts(partsByMessage[assistant.id] ?? [], textByPart, input.showWork)
    const previous = entries.at(-1)
    const first = next[0]
    const lastPart = previous?.type === "work" ? previous.parts.at(-1) : undefined
    const firstPart = first?.type === "work" ? first.parts[0] : undefined
    if (
      previous?.type === "work" &&
      first?.type === "work" &&
      !(lastPart?.type === "tool" && lastPart.state.status === "error") &&
      !(firstPart?.type === "tool" && firstPart.state.status === "error")
    ) {
      previous.parts.push(...first.parts)
      next.shift()
    }
    entries.push(...next)

    if (assistant === interruption) {
      if (entries.length > 0) {
        out.push({
          createdAt,
          entries,
          isStreaming: false,
          key: `${turnKey}:${segment}`,
          type: "assistant",
        })
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

    if (assistant.error && assistant.error.name !== "MessageAbortedError") {
      error ??= describeMessageError(assistant.error)
    }
  }

  if (entries.length > 0) {
    out.push({
      createdAt,
      entries,
      isStreaming: isActive && !error,
      key: interruption ? `${turnKey}:${segment}` : turnKey,
      type: "assistant",
    })
  }

  const revertMessageID = error?.guardrail
    ? (input.guardrailMessageID ?? input.messageID)
    : undefined
  if (error) {
    out.push({
      body: error.body,
      key: `assistant-error:${assistants.at(-1)?.id ?? "x"}`,
      label: error.label,
      revertMessageID,
      type: "assistant-error",
      partialOutput: entries.some((entry) => entry.type === "text"),
    })
  }
  return revertMessageID
}

export function projectTimeline(input: ProjectInput): {
  activity?: { text?: string; thinking: boolean; responding: boolean }
  guardrailMessageID?: string
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

  // Steering persists a new user message before the current model step ends.
  // Keep that step active until its own completion event arrives.
  const runningIndex = visible.findLastIndex((turn) =>
    turn.assistants.some((assistant) => !assistant.time.completed && !assistant.error)
  )
  const activeIndex = input.isBusy ? (runningIndex < 0 ? visible.length - 1 : runningIndex) : -1
  let activity: { text?: string; thinking: boolean; responding: boolean } | undefined
  const activeTurn = visible[activeIndex]
  if (activeTurn) {
    activity = { thinking: false, responding: false }
    for (const message of activeTurn.assistants) {
      for (const part of input.partsByMessage[message.id] ?? []) {
        if (part.type === "reasoning") {
          activity.thinking = true
          activity.responding = false
        }
        if (
          part.type === "text" &&
          !part.synthetic &&
          (input.textByPart[part.id] ?? part.text).trim()
        ) {
          activity.responding = true
        }
        if (part.type !== "tool") continue
        activity.responding = false
        activity.thinking = false
        if (part.tool !== "report_progress") continue
        if (part.state.status === "completed" || part.state.status === "running") {
          activity.text = part.state.title || activity.text
        }
      }
    }
  }
  let guardrailMessageID: string | undefined
  visible.forEach((turn, index) => {
    const userParts = input.partsByMessage[turn.user.id] ?? []
    const attachments = userParts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .flatMap((part) => {
        const attachment = attachmentFromPart(part)
        return attachment ? [attachment] : []
      })
    const compacted = userParts.some((part) => part.type === "compaction")
    let actor: MessageActor | undefined
    let inputID: string | undefined
    for (const part of userParts) {
      if (part.type !== "text") {
        continue
      }
      const parsed = messageActorSchema.safeParse(part.metadata?.["agentz.dev/actor"])
      if (parsed.success) {
        actor = parsed.data
      }
      const input = inputIDSchema.safeParse(part.metadata?.["agentz.dev/input-id"])
      if (input.success) inputID = input.data
      if (actor && inputID) break
    }

    const text = userText(turn.user.id)
    if (text || attachments.length > 0) {
      out.push({
        actor,
        attachments,
        createdAt: turn.user.time.created,
        // Gateway delivery preserves the submission ID through the SSE echo.
        key: inputID ? `input:${inputID}` : `user:${turn.user.id}`,
        messageID: turn.user.id,
        isWaiting: input.isBusy && index > activeIndex,
        text,
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

    const blockedMessageID = projectTurn({
      showWork: input.showWork ?? false,
      assistants: turn.assistants,
      compacted,
      isActive: index === activeIndex && !input.isRetrying,
      out,
      partsByMessage: input.partsByMessage,
      textByPart: input.textByPart,
      turnKey: `assistant:${turn.user.id}`,
      messageID: turn.user.id,
      guardrailMessageID,
    })
    if (blockedMessageID) {
      // Later requests include the rejected prompt. Reverting only the newest
      // failure would leave the original blocked message in the conversation.
      guardrailMessageID = blockedMessageID
    } else if (turn.assistants.some((assistant) => assistant.time.completed && !assistant.error)) {
      // A successful request can follow a policy change. Its old rejection
      // must not become the recovery target for an unrelated future failure.
      guardrailMessageID = undefined
    }
  })

  return { activity, guardrailMessageID, reverted, rows: out }
}
