"use client"

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { AgentWorkingIndicator } from "@/components/agent-working-indicator"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import {
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { ToolEntries, toolEntries } from "@/components/blocks/chat/tool-parts"
import { type LocalChatMessage, useOpencodeChat } from "@/components/blocks/chat/use-opencode-chat"
import { useOpencodeSend } from "@/components/blocks/chat/use-opencode-send"
import { listAgentProvidersAction } from "@/data/opencode.actions"
import type { ProviderModelItem } from "@/data/types"
import { createAgentOpencodeClientV2 } from "@/lib/opencode/client"
import { cn } from "@/lib/utils"
import type { Message as OpencodeMessage, Part } from "@opencode-ai/sdk"
import type { PermissionRequest, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useMutation } from "@tanstack/react-query"
import { CheckIcon } from "lucide-react"
import { startTransition, useActionState, useCallback, useMemo, useState, useEffect } from "react"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context"
import { Checkpoint, CheckpointIcon } from "@/components/ai-elements/checkpoint"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger as ReasoningSelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { LanguageModelUsage } from "ai"

type ChatProps = {
  agentName: string
  sessionId?: string
}

const DEFAULT_REASONING_LEVEL = "__default__"
const CUSTOM_ANSWER_KEY = "__custom__"

type RenderEntry =
  | {
      content: string
      key: string
      type: "text"
    }
  | {
      content: string
      key: string
      type: "reasoning"
    }
  | {
      key: string
      toolEntry: ReturnType<typeof toolEntries>[number]
      type: "tool"
    }
  | {
      key: string
      type: "checkpoint"
    }

function renderEntries(parts: Part[], textByPart: Record<string, string>): RenderEntry[] {
  const entries: RenderEntry[] = []
  let textBuffer: string[] = []
  let textKey: string[] = []
  let toolBuffer: Extract<Part, { type: "tool" }>[] = []

  function flushText() {
    const content = textBuffer.join("")
    if (content.trim().length > 0) {
      entries.push({
        content,
        key: textKey.join(":"),
        type: "text",
      })
    }
    textBuffer = []
    textKey = []
  }

  function flushTools() {
    if (toolBuffer.length === 0) return
    for (const entry of toolEntries(toolBuffer)) {
      entries.push({
        key: entry.key,
        toolEntry: entry,
        type: "tool",
      })
    }
    toolBuffer = []
  }

  for (const part of parts) {
    if (part.type === "text") {
      flushTools()

      const content = textByPart[part.id] ?? part.text
      if (content.length === 0) continue

      textBuffer.push(content)
      textKey.push(part.id)
      continue
    }

    if (part.type === "reasoning") {
      flushText()
      flushTools()

      const content = textByPart[part.id] ?? part.text
      if (content.trim().length === 0) continue

      entries.push({
        content,
        key: part.id,
        type: "reasoning",
      })
      continue
    }

    if (part.type === "tool") {
      flushText()
      toolBuffer.push(part)
      continue
    }

    if (part.type === "compaction") {
      flushText()
      flushTools()

      entries.push({
        key: part.id,
        type: "checkpoint",
      })
      continue
    }

    flushText()
    flushTools()
  }

  flushText()
  flushTools()

  return entries
}

type RenderMessage = {
  createdAt: number
  entries: RenderEntry[]
  from: OpencodeMessage["role"]
  key: string
}

type RenderBlock = {
  createdAt: number
  entries: RenderEntry[]
  from: OpencodeMessage["role"]
  key: string
}

type LocalRenderBlock = {
  createdAt: number
  key: string
  message: LocalChatMessage
  type: "local"
}

type ToolRenderEntry = Extract<RenderEntry, { type: "tool" }>
type CheckpointRenderEntry = Extract<RenderEntry, { type: "checkpoint" }>

type AssistantUsage = {
  modelId?: string
  modelName?: string
  providerID?: string
  total: number
  usage: LanguageModelUsage
  usedTokens: number
  maxTokens?: number
}

type QuestionDraftState = {
  custom: Record<number, string>
  customEnabled: Record<number, boolean>
  questionIndex: number
  selected: Record<number, string[]>
}

function CustomAnswerInput({
  defaultValue,
  disabled,
  onCommit,
}: {
  defaultValue: string
  disabled: boolean
  onCommit: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue)

  return (
    <Input
      autoFocus
      aria-label="Custom answer"
      className="h-9 rounded-none border-x-0 border-t-0 border-b border-border bg-transparent px-2 shadow-none focus-visible:ring-0"
      disabled={disabled}
      onBlur={(event) => onCommit(event.target.value)}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Type your own answer"
      value={value}
    />
  )
}

function permissionTitle(request: PermissionRequest) {
  switch (request.permission) {
    case "edit":
      return "Edit files"
    case "read":
      return "Read files"
    case "glob":
      return "Match files"
    case "grep":
      return "Search file contents"
    case "list":
      return "List directory contents"
    case "task":
      return "Spawn subagent task"
    case "webfetch":
      return "Fetch web page"
    case "websearch":
      return "Search the web"
    case "external_directory":
      return "Access external directory"
    case "doom_loop":
      return "Continue after repeated failures"
    default:
      return `Call tool ${request.permission}`
  }
}

function permissionDescription(request: PermissionRequest) {
  const meta = request.metadata ?? {}

  switch (request.permission) {
    case "edit":
      return typeof meta.filepath === "string"
        ? `Target: ${meta.filepath}`
        : "The agent wants to modify files."
    case "read":
      return typeof meta.filepath === "string"
        ? `Path: ${meta.filepath}`
        : "The agent wants to read a file."
    case "glob":
      return request.patterns[0]
        ? `Pattern: ${request.patterns[0]}`
        : "The agent wants to match files by glob."
    case "grep":
      return request.patterns[0]
        ? `Pattern: ${request.patterns[0]}`
        : "The agent wants to search file contents."
    case "list":
      return request.patterns[0]
        ? `Path: ${request.patterns[0]}`
        : "The agent wants to list files in a directory."
    case "task":
      return typeof meta.description === "string"
        ? meta.description
        : "The agent wants to delegate work to a subagent."
    case "webfetch":
      return request.patterns[0]
        ? `URL: ${request.patterns[0]}`
        : "The agent wants to fetch a web page."
    case "websearch":
      return request.patterns[0]
        ? `Query: ${request.patterns[0]}`
        : "The agent wants to search the web."
    case "external_directory":
      return request.patterns[0]
        ? `Pattern: ${request.patterns[0]}`
        : "The agent wants to access a directory outside the workspace."
    case "doom_loop":
      return "This keeps the run going despite repeated failures."
    default:
      return `Permission: ${request.permission}`
  }
}

function questionAnswers(state: QuestionDraftState, request: QuestionRequest): QuestionAnswer[] {
  return request.questions.map((question, index) => {
    const selected = state.selected[index] ?? []
    const custom = state.custom[index]?.trim()

    if (question.multiple !== true) {
      if (selected[0] === CUSTOM_ANSWER_KEY) {
        return custom ? [custom] : []
      }

      return selected.slice(0, 1)
    }

    const answers = selected.filter((item) => item !== CUSTOM_ANSWER_KEY)
    if ((state.customEnabled[index] ?? false) && custom) {
      answers.push(custom)
    }
    return answers
  })
}

function getAssistantUsage(
  messages: OpencodeMessage[],
  models: ProviderModelItem[]
): AssistantUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant") continue

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    if (total <= 0) continue

    const model = models.find((item) => {
      return item.providerID === message.providerID && item.modelID === message.modelID
    })

    return {
      maxTokens: model?.contextLimit,
      modelId: `${message.providerID}:${message.modelID}`,
      modelName: model?.name ?? message.modelID,
      providerID: message.providerID,
      total,
      usedTokens: total,
      usage: {
        inputTokens: message.tokens.input,
        inputTokenDetails: {
          cacheReadTokens: message.tokens.cache.read,
          cacheWriteTokens: message.tokens.cache.write,
          noCacheTokens: message.tokens.input,
        },
        outputTokens: message.tokens.output,
        outputTokenDetails: {
          reasoningTokens: message.tokens.reasoning,
          textTokens: message.tokens.output,
        },
        cachedInputTokens: message.tokens.cache.read,
        reasoningTokens: message.tokens.reasoning,
        totalTokens: total,
      },
    }
  }
}

function AttachmentItem({
  attachment,
  onRemove,
}: {
  attachment: AttachmentData
  onRemove: (id: string) => void
}) {
  const handleRemove = useCallback(() => {
    onRemove(attachment.id)
  }, [attachment.id, onRemove])

  return (
    <Attachment data={attachment} onRemove={handleRemove}>
      <AttachmentPreview />
      <AttachmentRemove />
    </Attachment>
  )
}

function PromptInputAttachmentsDisplay() {
  const attachments = usePromptInputAttachments()

  const handleRemove = useCallback(
    (id: string) => {
      attachments.remove(id)
    },
    [attachments]
  )

  if (attachments.files.length === 0) {
    return null
  }

  return (
    <Attachments variant="inline">
      {attachments.files.map((attachment) => (
        <AttachmentItem attachment={attachment} key={attachment.id} onRemove={handleRemove} />
      ))}
    </Attachments>
  )
}

function QuestionDock({
  onReject,
  onSubmit,
  pending,
  request,
}: {
  onReject: () => void
  onSubmit: (answers: QuestionAnswer[]) => void
  pending: boolean
  request: QuestionRequest
}) {
  const [localState, setLocalState] = useState<QuestionDraftState>(() => ({
    custom: Object.fromEntries(request.questions.map((_, index) => [index, ""])),
    customEnabled: Object.fromEntries(request.questions.map((_, index) => [index, false])),
    questionIndex: 0,
    selected: Object.fromEntries(request.questions.map((_, index) => [index, []])),
  }))

  const question = request.questions[localState.questionIndex]
  const selected = useMemo(() => {
    return localState.selected[localState.questionIndex] ?? []
  }, [localState.questionIndex, localState.selected])
  const customEnabled =
    question.custom !== false && (localState.customEnabled[localState.questionIndex] ?? false)
  const total = request.questions.length
  const isLast = localState.questionIndex === total - 1
  const answers = questionAnswers(localState, request)
  const currentAnswered = answers[localState.questionIndex]?.length > 0 || customEnabled

  const updateState = useCallback(
    (updater: (current: QuestionDraftState) => QuestionDraftState) => {
      setLocalState(updater)
    },
    []
  )

  const setCustomValue = useCallback(
    (next: string) => {
      updateState((current) => ({
        ...current,
        custom: {
          ...current.custom,
          [current.questionIndex]: next,
        },
      }))
    },
    [updateState]
  )

  const setQuestionIndex = useCallback(
    (index: number) => {
      updateState((current) => ({
        ...current,
        questionIndex: index,
      }))
    },
    [updateState]
  )

  const handleSingleSelect = useCallback(
    (value: string) => {
      updateState((current) => ({
        ...current,
        customEnabled: {
          ...current.customEnabled,
          [current.questionIndex]: value === CUSTOM_ANSWER_KEY,
        },
        selected: {
          ...current.selected,
          [current.questionIndex]: value ? [value] : [],
        },
      }))
    },
    [updateState]
  )

  const handleMultiSelect = useCallback(
    (value: string[]) => {
      updateState((current) => ({
        ...current,
        customEnabled: {
          ...current.customEnabled,
          [current.questionIndex]: value.includes(CUSTOM_ANSWER_KEY),
        },
        selected: {
          ...current.selected,
          [current.questionIndex]: value,
        },
      }))
    },
    [updateState]
  )

  const selectOption = useCallback(
    (value: string) => {
      if (question.multiple === true) {
        const next = selected.includes(value)
          ? selected.filter((item) => item !== value)
          : [...selected, value]
        handleMultiSelect(next)
        return
      }

      handleSingleSelect(value)
    },
    [handleMultiSelect, handleSingleSelect, question.multiple, selected]
  )

  const nextQuestion = useCallback(() => {
    const nextAnswers = questionAnswers(localState, request)

    if (!isLast) {
      setLocalState((current) => ({
        ...current,
        questionIndex: current.questionIndex + 1,
      }))
      return
    }

    onSubmit(nextAnswers)
  }, [isLast, localState, onSubmit, request])

  const previousQuestion = useCallback(() => {
    if (localState.questionIndex === 0) return
    setQuestionIndex(localState.questionIndex - 1)
  }, [localState.questionIndex, setQuestionIndex])

  return (
    <div className="mx-auto w-full px-4 lg:w-4/5 lg:px-0">
      <div className="border-l-2 border-primary bg-card">
        <div className="flex flex-col gap-4 px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="font-medium text-foreground text-sm">{question.header}</div>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {localState.questionIndex + 1}/{total}
              </div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-2">
              {request.questions.map((item, index) => {
                const answered =
                  (answers[index]?.length ?? 0) > 0 || (localState.customEnabled[index] ?? false)
                return (
                  <button
                    aria-label={item.header}
                    className={cn(
                      "h-1.5 rounded-full transition-colors",
                      index === localState.questionIndex
                        ? "bg-foreground"
                        : answered
                          ? "bg-primary/60"
                          : "bg-muted"
                    )}
                    disabled={pending}
                    key={`${item.header}-${index}`}
                    onClick={() => setQuestionIndex(index)}
                    type="button"
                  />
                )
              })}
            </div>
          </div>
          <div className="text-foreground text-sm">
            {question.question}
            {question.multiple === true ? " (select all that apply)" : ""}
          </div>
          <FieldGroup>
            {question.multiple === true ? (
              <div className="flex flex-col gap-3">
                {question.options.map((option) => {
                  const checked = selected.includes(option.label)
                  return (
                    <label className="flex items-start gap-3" key={option.label}>
                      <Checkbox
                        checked={checked}
                        disabled={pending}
                        onCheckedChange={() => selectOption(option.label)}
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="text-foreground text-sm">{option.label}</span>
                        <span className="text-muted-foreground text-sm">{option.description}</span>
                      </span>
                    </label>
                  )
                })}
                {question.custom !== false ? (
                  <div className="flex flex-col gap-2">
                    <label className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.includes(CUSTOM_ANSWER_KEY)}
                        disabled={pending}
                        onCheckedChange={() => selectOption(CUSTOM_ANSWER_KEY)}
                      />
                      <span className="text-foreground text-sm">Type your own answer</span>
                    </label>
                    {customEnabled ? (
                      <CustomAnswerInput
                        defaultValue={localState.custom[localState.questionIndex] ?? ""}
                        disabled={pending}
                        key={`${request.id}:${localState.questionIndex}`}
                        onCommit={setCustomValue}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <RadioGroup
                className="flex flex-col gap-3"
                disabled={pending}
                onValueChange={handleSingleSelect}
                value={selected[0] ?? ""}
              >
                {question.options.map((option) => (
                  <label className="flex items-start gap-3" key={option.label}>
                    <RadioGroupItem value={option.label} />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-foreground text-sm">{option.label}</span>
                      <span className="text-muted-foreground text-sm">{option.description}</span>
                    </span>
                  </label>
                ))}
                {question.custom !== false ? (
                  <div className="flex flex-col gap-2">
                    <label className="flex items-start gap-3">
                      <RadioGroupItem value={CUSTOM_ANSWER_KEY} />
                      <span className="text-foreground text-sm">Type your own answer</span>
                    </label>
                    {customEnabled ? (
                      <CustomAnswerInput
                        defaultValue={localState.custom[localState.questionIndex] ?? ""}
                        disabled={pending}
                        key={`${request.id}:${localState.questionIndex}`}
                        onCommit={setCustomValue}
                      />
                    ) : null}
                  </div>
                ) : null}
              </RadioGroup>
            )}
          </FieldGroup>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button disabled={pending} onClick={onReject} type="button" variant="destructive">
              Reject
            </Button>
            <div className="flex items-center gap-2 self-end">
              {localState.questionIndex > 0 ? (
                <Button
                  disabled={pending}
                  onClick={previousQuestion}
                  type="button"
                  variant="secondary"
                >
                  Back
                </Button>
              ) : null}
              <Button disabled={pending || !currentAnswered} onClick={nextQuestion} type="button">
                {pending ? <Spinner /> : null}
                {isLast ? "Submit" : "Next"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PermissionDock({
  allowAlways,
  onDecide,
  pending,
  request,
}: {
  allowAlways: boolean
  onDecide: (reply: "always" | "once" | "reject") => void
  pending: boolean
  request: PermissionRequest
}) {
  const cancelLabel = allowAlways ? "Cancel" : "Deny"

  return (
    <div className="mx-auto w-full px-4 lg:w-4/5 lg:px-0">
      <div className="border-l-2 border-primary bg-card">
        <div className="flex flex-col gap-4 px-4 py-3">
          <div className="flex flex-col gap-2">
            <div className="font-medium text-foreground text-sm">
              {allowAlways ? "Always allow" : permissionTitle(request)}
            </div>
          </div>
          <div className="text-foreground text-sm">
            {allowAlways ? "Confirm persistent approval" : permissionDescription(request)}
            {allowAlways ? (
              <div className="mt-1 text-muted-foreground text-xs">
                {request.always.length === 1 && request.always[0] === "*"
                  ? `Allow ${request.permission} until restart.`
                  : "Allow these patterns until restart."}
              </div>
            ) : null}
          </div>
          {request.patterns.length > 0 ? (
            <FieldSet>
              <FieldLegend>Patterns</FieldLegend>
              <div className="grid gap-2">
                {request.patterns.map((pattern) => (
                  <div className="px-0 py-1 font-mono text-sm text-foreground" key={pattern}>
                    - {pattern}
                  </div>
                ))}
              </div>
            </FieldSet>
          ) : null}
          {allowAlways && request.always.length > 0 ? (
            <FieldSet>
              <FieldLegend>Always-allow scope</FieldLegend>
              <div className="grid gap-2">
                {request.always.map((pattern) => (
                  <div className="px-0 py-1 font-mono text-sm text-foreground" key={pattern}>
                    - {pattern}
                  </div>
                ))}
              </div>
            </FieldSet>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              disabled={pending}
              onClick={() => onDecide("reject")}
              type="button"
              variant="destructive"
            >
              {cancelLabel}
            </Button>
            <div className="flex items-center gap-2 self-end">
              {allowAlways ? (
                <Button disabled={pending} onClick={() => onDecide("always")} type="button">
                  {pending ? <Spinner /> : null}
                  Confirm
                </Button>
              ) : (
                <>
                  <Button
                    disabled={pending}
                    onClick={() => onDecide("always")}
                    type="button"
                    variant="secondary"
                  >
                    Always allow
                  </Button>
                  <Button disabled={pending} onClick={() => onDecide("once")} type="button">
                    {pending ? <Spinner /> : null}
                    Allow once
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelItem({
  isSelected,
  model,
  onSelect,
}: {
  isSelected: boolean
  model: ProviderModelItem
  onSelect: (id: string) => void
}) {
  const handleSelect = useCallback(() => {
    onSelect(model.id)
  }, [model.id, onSelect])

  return (
    <ModelSelectorItem onSelect={handleSelect} value={model.id}>
      <ModelSelectorLogo provider={model.chefSlug} />
      <ModelSelectorName>{model.name}</ModelSelectorName>
      <ModelSelectorLogoGroup>
        <ModelSelectorLogo key={model.providerID} provider={model.providerID} />
      </ModelSelectorLogoGroup>
      {isSelected ? <CheckIcon className="ml-auto size-4" /> : <div className="ml-auto size-4" />}
    </ModelSelectorItem>
  )
}

function ChatInner({ agentName, sessionId }: ChatProps) {
  const {
    blocked,
    historyError,
    isBusy,
    isPending,
    localMessages,
    messages,
    permissionRequest,
    partsByMessage,
    questionRequest,
    streamError,
    textByPart,
  } = useOpencodeChat(agentName, sessionId)
  const [model, setModel] = useState<string>("")
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [permissionAlwaysConfirmRequestID, setPermissionAlwaysConfirmRequestID] = useState<
    string | undefined
  >()
  const [reasoningLevel, setReasoningLevel] = useState<string>(DEFAULT_REASONING_LEVEL)
  const opencodeClient = useMemo(() => {
    return createAgentOpencodeClientV2(agentName)
  }, [agentName])
  const permissionAlwaysConfirm = permissionAlwaysConfirmRequestID === permissionRequest?.id

  const [providerState, loadProviders] = useActionState(
    async (
      _prevState: Awaited<ReturnType<typeof listAgentProvidersAction>> | null,
      payload: string
    ) => {
      return listAgentProvidersAction(payload)
    },
    null
  )

  useEffect(() => {
    startTransition(() => {
      loadProviders(agentName)
    })
  }, [loadProviders, agentName])

  const models = useMemo(() => providerState?.models ?? [], [providerState?.models])
  const chefs = useMemo(() => providerState?.chefs ?? [], [providerState?.chefs])
  const selectedModelID = model || models[0]?.id || ""

  const selectedModel = useMemo(() => {
    return models.find((item) => item.id === selectedModelID)
  }, [models, selectedModelID])
  const reasoningVariants = useMemo(() => {
    return selectedModel?.variants ?? []
  }, [selectedModel?.variants])
  const selectedReasoningLevel = useMemo(() => {
    if (reasoningVariants.length === 0) {
      return DEFAULT_REASONING_LEVEL
    }

    if (reasoningLevel !== DEFAULT_REASONING_LEVEL && reasoningVariants.includes(reasoningLevel)) {
      return reasoningLevel
    }

    return DEFAULT_REASONING_LEVEL
  }, [reasoningLevel, reasoningVariants])
  const selectedReasoningVariant = useMemo(() => {
    if (selectedReasoningLevel === DEFAULT_REASONING_LEVEL) {
      return undefined
    }

    return selectedReasoningLevel
  }, [selectedReasoningLevel])

  const contextUsage = useMemo(() => {
    return getAssistantUsage(messages, models)
  }, [messages, models])
  const { abortMessage, canSubmit, sendMessage, sendState } = useOpencodeSend(
    agentName,
    sessionId,
    isBusy || blocked
  )
  const { isPending: isQuestionPending, mutateAsync: submitQuestionAnswer } = useMutation({
    mutationFn: async (answers: QuestionAnswer[]) => {
      if (!questionRequest) {
        throw new Error("No question request is active")
      }

      const result = await opencodeClient.question.reply({
        answers,
        requestID: questionRequest.id,
      })

      if (result.error || result.data !== true) {
        throw new Error(result.error?.data?.message ?? "Failed to answer question")
      }
    },
  })

  const { isPending: isQuestionRejectPending, mutateAsync: rejectQuestion } = useMutation({
    mutationFn: async () => {
      if (!questionRequest) {
        throw new Error("No question request is active")
      }

      const result = await opencodeClient.question.reject({
        requestID: questionRequest.id,
      })

      if (result.error || result.data !== true) {
        throw new Error(result.error?.data?.message ?? "Failed to reject question")
      }
    },
  })

  const { isPending: isPermissionPending, mutateAsync: replyPermission } = useMutation({
    mutationFn: async (reply: "always" | "once" | "reject") => {
      if (!permissionRequest) {
        throw new Error("No permission request is active")
      }

      const result = await opencodeClient.permission.reply({
        reply,
        requestID: permissionRequest.id,
      })

      if (result.error || result.data !== true) {
        throw new Error(result.error?.data?.message ?? "Failed to respond to permission")
      }
    },
  })

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      await sendMessage({
        model: selectedModel,
        sessionID: sessionId,
        text: message.text,
        variant: selectedReasoningVariant,
      })
    },
    [selectedModel, selectedReasoningVariant, sendMessage, sessionId]
  )

  const handlePermissionDecision = useCallback(
    async (reply: "always" | "once" | "reject") => {
      if (reply === "always" && !permissionAlwaysConfirm) {
        setPermissionAlwaysConfirmRequestID(permissionRequest?.id)
        return
      }

      if (reply === "reject" && permissionAlwaysConfirm) {
        setPermissionAlwaysConfirmRequestID(undefined)
        return
      }

      await replyPermission(reply)
      setPermissionAlwaysConfirmRequestID(undefined)
    },
    [permissionAlwaysConfirm, permissionRequest?.id, replyPermission]
  )

  const handleModelSelect = useCallback((modelId: string) => {
    setModel(modelId)
    setModelSelectorOpen(false)
  }, [])

  const visibleMessages = messages.filter((message) => {
    const parts = partsByMessage[message.id] ?? []
    return renderEntries(parts, textByPart).length > 0
  })
  const renderMessages: RenderMessage[] = visibleMessages.map((message) => {
    const parts = partsByMessage[message.id] ?? []
    const entries = renderEntries(parts, textByPart)

    return {
      createdAt: message.time.created,
      entries,
      from: message.role,
      key: message.id,
    }
  })
  const lastCreatedAt = renderMessages.at(-1)?.createdAt ?? localMessages.at(-1)?.createdAt ?? 0

  const renderBlocks: Array<LocalRenderBlock | RenderBlock> = []
  let assistantBlock: RenderBlock | undefined

  function flushAssistantBlock() {
    if (!assistantBlock) {
      return
    }

    renderBlocks.push(assistantBlock)
    assistantBlock = undefined
  }

  for (const localMessage of localMessages) {
    renderBlocks.push({
      createdAt: localMessage.createdAt,
      key: localMessage.id,
      message: localMessage,
      type: "local",
    })
  }

  if (historyError) {
    renderBlocks.push({
      createdAt: lastCreatedAt + 1,
      key: "history-error",
      message: {
        content: historyError,
        createdAt: lastCreatedAt + 1,
        id: "history-error",
        kind: "system",
      },
      type: "local",
    })
  }

  if (streamError) {
    renderBlocks.push({
      createdAt: lastCreatedAt + 2,
      key: "stream-error",
      message: {
        content: streamError,
        createdAt: lastCreatedAt + 2,
        id: "stream-error",
        kind: "system",
      },
      type: "local",
    })
  }

  for (const message of renderMessages) {
    if (message.from === "assistant") {
      if (!assistantBlock) {
        assistantBlock = {
          createdAt: message.createdAt,
          entries: [...message.entries],
          from: message.from,
          key: message.key,
        }
        continue
      }

      assistantBlock.entries.push(...message.entries)
      assistantBlock.key = `${assistantBlock.key}:${message.key}`
      continue
    }

    flushAssistantBlock()
    renderBlocks.push({
      createdAt: message.createdAt,
      entries: message.entries,
      from: message.from,
      key: message.key,
    })
  }

  flushAssistantBlock()
  renderBlocks.sort((x, y) => x.createdAt - y.createdAt)

  function groupEntries(entries: RenderEntry[]) {
    const result: (
      | RenderEntry
      | { type: "tool-group"; entries: ToolRenderEntry[]; key: string }
    )[] = []
    let toolGroup: ToolRenderEntry[] = []

    function flushToolGroup() {
      if (toolGroup.length === 0) return
      result.push({
        type: "tool-group",
        entries: [...toolGroup],
        key: toolGroup.map((e) => e.key).join(":"),
      })
      toolGroup = []
    }

    for (const entry of entries) {
      if (entry.type === "tool") {
        toolGroup.push(entry)
      } else {
        flushToolGroup()
        result.push(entry)
      }
    }

    flushToolGroup()
    return result
  }

  function renderCheckpoint(entry: CheckpointRenderEntry) {
    return (
      <Checkpoint className="w-full py-1 text-sm leading-4" key={entry.key}>
        <CheckpointIcon className="size-3.5" />
        <span className="whitespace-nowrap">Context compacted</span>
      </Checkpoint>
    )
  }

  const lastBlock = renderBlocks.at(-1)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {isBusy && (
        <div aria-hidden="true" data-component="session-progress" data-state="showing">
          <div data-component="session-progress-bar" />
        </div>
      )}
      <Conversation>
        <ConversationContent className="w-full px-4">
          {isPending ? (
            <div className="flex min-h-48 items-center justify-center">
              <Spinner aria-label="Loading session messages" />
            </div>
          ) : (
            <>
              <div className="mx-auto flex w-full flex-col gap-4 lg:w-4/5">
                {renderBlocks.map((block) => {
                  if ("message" in block) {
                    if (block.message.kind === "system") {
                      return (
                        <Message
                          className="is-system-message mx-auto w-full max-w-full items-center"
                          from="assistant"
                          key={block.key}
                        >
                          <MessageContent className="w-fit rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive">
                            <MessageResponse>{block.message.content}</MessageResponse>
                          </MessageContent>
                        </Message>
                      )
                    }

                    return (
                      <Message from="user" key={block.key}>
                        <MessageContent
                          className={
                            block.message.status === "failed"
                              ? "border border-destructive/30 bg-destructive/10 text-destructive"
                              : undefined
                          }
                        >
                          <MessageResponse>{block.message.text}</MessageResponse>
                        </MessageContent>
                      </Message>
                    )
                  }

                  const isLastBlock = lastBlock?.key === block.key
                  const groups = groupEntries(block.entries)
                  const lastGroupIndex = groups.length - 1
                  const checkpoints = groups.filter(
                    (group): group is CheckpointRenderEntry => group.type === "checkpoint"
                  )
                  const contentGroups = groups.filter((group) => group.type !== "checkpoint")

                  return (
                    <div className="flex flex-col gap-2" key={block.key}>
                      {checkpoints.map(renderCheckpoint)}
                      {contentGroups.length > 0 ? (
                        <Message from={block.from}>
                          <MessageContent>
                            {contentGroups.map((group, groupIndex) => {
                              if (group.type === "text") {
                                return (
                                  <MessageResponse key={group.key}>{group.content}</MessageResponse>
                                )
                              }
                              if (group.type === "reasoning") {
                                const isStreaming =
                                  isBusy &&
                                  block.from === "assistant" &&
                                  isLastBlock &&
                                  groupIndex === lastGroupIndex
                                return (
                                  <Reasoning isStreaming={isStreaming} key={group.key}>
                                    <ReasoningTrigger />
                                    <ReasoningContent>{group.content}</ReasoningContent>
                                  </Reasoning>
                                )
                              }
                              if (group.type === "tool-group") {
                                return (
                                  <div
                                    className="rounded-md bg-muted p-2 dark:bg-card"
                                    key={group.key}
                                  >
                                    {group.entries.map((entry) => (
                                      <ToolEntries
                                        agentName={agentName}
                                        entry={entry.toolEntry}
                                        key={entry.key}
                                      />
                                    ))}
                                  </div>
                                )
                              }
                              return null
                            })}
                          </MessageContent>
                        </Message>
                      ) : null}
                    </div>
                  )
                })}
                <AgentWorkingIndicator isWorking={isBusy} />
              </div>
              {permissionRequest ? (
                <PermissionDock
                  allowAlways={permissionAlwaysConfirm}
                  onDecide={(reply) => {
                    void handlePermissionDecision(reply)
                  }}
                  pending={isPermissionPending}
                  request={permissionRequest}
                />
              ) : null}
              {questionRequest ? (
                <QuestionDock
                  onReject={() => {
                    void rejectQuestion()
                  }}
                  onSubmit={(answers) => {
                    void submitQuestionAnswer(answers)
                  }}
                  pending={isQuestionPending || isQuestionRejectPending}
                  key={questionRequest.id}
                  request={questionRequest}
                />
              ) : null}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 pt-4">
        <div className="mx-auto w-full pb-4 lg:w-4/5 lg:px-0 px-4">
          <PromptInput globalDrop multiple onSubmit={handleSubmit}>
            <PromptInputHeader>
              <PromptInputAttachmentsDisplay />
            </PromptInputHeader>
            <PromptInputBody>
              <PromptInputTextarea disabled={blocked} />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                <div className="flex items-center gap-1">
                  <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
                    <ModelSelectorTrigger asChild>
                      <PromptInputButton>
                        {selectedModel?.chefSlug ? (
                          <ModelSelectorLogo provider={selectedModel.chefSlug} />
                        ) : null}
                        {selectedModel?.name ? (
                          <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
                        ) : (
                          <ModelSelectorName>Model</ModelSelectorName>
                        )}
                      </PromptInputButton>
                    </ModelSelectorTrigger>
                    <ModelSelectorContent>
                      <ModelSelectorInput placeholder="Search models..." />
                      <ModelSelectorList>
                        <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                        {chefs.map((chef) => (
                          <ModelSelectorGroup heading={chef} key={chef}>
                            {models
                              .filter((item) => item.chef === chef)
                              .map((item) => (
                                <ModelItem
                                  isSelected={selectedModelID === item.id}
                                  key={item.id}
                                  model={item}
                                  onSelect={handleModelSelect}
                                />
                              ))}
                          </ModelSelectorGroup>
                        ))}
                      </ModelSelectorList>
                    </ModelSelectorContent>
                  </ModelSelector>
                  {contextUsage?.maxTokens && contextUsage.maxTokens > 0 ? (
                    <Context
                      maxTokens={contextUsage.maxTokens}
                      modelId={contextUsage.modelId}
                      usage={contextUsage.usage}
                      usedTokens={contextUsage.usedTokens}
                    >
                      <ContextTrigger className="gap-1 px-2" />
                      <ContextContent>
                        <ContextContentHeader />
                        <ContextContentBody className="space-y-2">
                          <ContextInputUsage />
                          <ContextOutputUsage />
                          <ContextReasoningUsage />
                          <ContextCacheUsage />
                        </ContextContentBody>
                        <ContextContentFooter />
                      </ContextContent>
                    </Context>
                  ) : null}
                  {reasoningVariants.length > 0 ? (
                    <Select onValueChange={setReasoningLevel} value={selectedReasoningLevel}>
                      <ReasoningSelectTrigger
                        aria-label="Reasoning level"
                        className="h-8 min-w-16 gap-1 px-2 text-xs"
                        size="sm"
                        variant="ghost"
                      >
                        <SelectValue placeholder="Reasoning" />
                      </ReasoningSelectTrigger>
                      <SelectContent align="end" position="popper" side="top" sideOffset={8}>
                        <SelectItem value={DEFAULT_REASONING_LEVEL}>Default</SelectItem>
                        {reasoningVariants.map((variant) => (
                          <SelectItem key={variant} value={variant}>
                            {variant.length ? variant[0].toUpperCase() + variant.slice(1) : variant}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              </PromptInputTools>
              <PromptInputSubmit
                disabled={!selectedModel || !canSubmit || blocked}
                onStop={isBusy ? abortMessage : undefined}
                status={isBusy ? "streaming" : sendState}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  )
}

export default function Chat(props: ChatProps) {
  return <ChatInner key={`${props.agentName}:${props.sessionId ?? "new"}`} {...props} />
}
