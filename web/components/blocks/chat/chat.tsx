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
} from "@/components/ai-elements/attachments"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { AgentGettingReady, useAgentReadiness } from "@/components/agent-readiness"
import { AgentWorkingIndicator } from "@/components/agent-working-indicator"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import type {
  PromptInputController,
  PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroupAddon } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { useChatModelStorage } from "@/components/blocks/chat/use-chat-model-storage"
import { NewSessionGreeting } from "@/components/blocks/chat/new-session-greeting"
import { useOpencodeChat } from "@/components/blocks/chat/use-opencode-chat"
import { useOpencodeSend } from "@/components/blocks/chat/use-opencode-send"
import {
  type PermissionDecision,
  PermissionDock,
  QuestionDock,
  RevertDock,
  TodoDock,
} from "@/components/blocks/chat/docks"
import { CopyButton } from "@/components/ui/copy-button"
import {
  type RenderEntry,
  projectTimeline,
  type TimelineRow,
} from "@/components/blocks/chat/timeline"
import { opencodeErrorMessage } from "@/components/blocks/chat/errors"
import { ToolEntries } from "@/components/blocks/chat/tool-parts"
import {
  chatAttachmentConfig,
  chatAttachmentErrorMessage,
  messageHasRenderableContent,
} from "@/components/blocks/chat/attachments"
import type { ProviderModelItem } from "@/data/types"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { formatMessageTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Message as OpencodeMessage, Part, QuestionAnswer } from "@opencode-ai/sdk/v2"
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import {
  BotIcon,
  BrainCircuitIcon,
  CheckIcon,
  ChevronDownIcon,
  PaperclipIcon,
  Settings2Icon,
  Undo2Icon,
} from "lucide-react"
import { motion } from "motion/react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger as ReasoningSelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { LanguageModelUsage } from "ai"

type ChatProps = {
  agentName: string
  firstName?: string
  greetingIndex?: number
  sessionId?: string
}

const DEFAULT_REASONING_LEVEL = "__default__"
const promptShiftTransition = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const

function RetryCountdown({
  attempt,
  message,
  next,
}: {
  attempt: number
  message: string
  next: number
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remainingMs = Math.max(0, next - now)
  const seconds = Math.ceil(remainingMs / 1000)

  return (
    <Alert variant="destructive">
      <AlertTitle>
        Retrying turn{attempt > 0 ? ` (attempt ${attempt})` : null}
        {seconds > 0 ? ` in ${seconds}s` : null}
      </AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

type AssistantUsage = {
  modelId?: string
  modelName?: string
  providerID?: string
  total: number
  usage: LanguageModelUsage
  usedTokens: number
  maxTokens?: number
}

function getAssistantUsage(
  messages: OpencodeMessage[],
  models: ProviderModelItem[]
): AssistantUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
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
  return undefined
}

function PromptInputAttachmentsDisplay() {
  const attachments = usePromptInputAttachments()

  if (attachments.files.length === 0) {
    return null
  }

  return (
    <InputGroupAddon
      align="block-start"
      className="order-first flex-wrap gap-2 px-3 pt-1 pb-1 empty:hidden"
    >
      <Attachments variant="inline">
        {attachments.files.map((attachment) => {
          const handleRemove = () => attachments.remove(attachment.id)

          return (
            <Attachment data={attachment} key={attachment.id} onRemove={handleRemove}>
              <AttachmentPreview />
              <AttachmentRemove />
            </Attachment>
          )
        })}
      </Attachments>
    </InputGroupAddon>
  )
}

function PromptInputAttachmentButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments()

  return (
    <PromptInputButton
      aria-label="Attach files"
      className="size-8"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      tooltip="Add photos & files"
    >
      <PaperclipIcon />
    </PromptInputButton>
  )
}

// Consecutive tool entries share one indentation block; text and reasoning
// entries stay standalone.
type EntryGroup =
  | RenderEntry
  | { entries: Extract<RenderEntry, { type: "tool" }>[]; key: string; type: "tool-group" }

function groupEntries(entries: RenderEntry[]): EntryGroup[] {
  const result: EntryGroup[] = []
  let group: Extract<RenderEntry, { type: "tool" }>[] = []

  const flush = () => {
    if (group.length === 0) return
    result.push({
      entries: [...group],
      key: group.map((entry) => entry.key).join(":"),
      type: "tool-group",
    })
    group = []
  }

  for (const entry of entries) {
    if (entry.type === "tool") {
      group.push(entry)
      continue
    }
    flush()
    result.push(entry)
  }

  flush()
  return result
}

function ChatInner({ agentName, firstName, greetingIndex, sessionId }: ChatProps) {
  const [promotedSessionId, setPromotedSessionId] = useState<string>()
  const activeSessionId = sessionId ?? promotedSessionId
  const agentReadiness = useAgentReadiness(agentName)
  const composerRef = useRef<PromptInputController | null>(null)

  const {
    applyOptimisticSession,
    blocked,
    historyError,
    isBusy,
    isPending,
    localMessages,
    messages,
    partsByMessage,
    permissionRequest,
    questionRequest,
    reconnectStream,
    reloadHistory,
    session,
    sessionCost,
    sessionStatus,
    streamError,
    textByPart,
    todos,
  } = useOpencodeChat(agentName, activeSessionId)
  const directory = session?.directory
  const [model, setModel] = useState<string>("")
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [reasoningLevel, setReasoningLevel] = useState<string>(DEFAULT_REASONING_LEVEL)
  const {
    clearInvalid,
    getVariant,
    pushRecent,
    ready: modelStorageReady,
    recent,
    setVariant,
  } = useChatModelStorage(agentName)

  const modelCatalog = useQuery(
    queryOptions({
      queryKey: ["opencode", "modelCatalog", agentName],
      queryFn: async () => {
        const client = await createAgentOpencodeClient(agentName)
        const [providersResult, configResult, agentsResult] = await Promise.all([
          client.config.providers(),
          client.config.get(),
          client.app.agents(),
        ])

        if (providersResult.error || !providersResult.data) {
          throw new Error("Failed to load providers")
        }
        if (configResult.error || !configResult.data) {
          throw new Error("Failed to load config")
        }
        if (agentsResult.error || !agentsResult.data) {
          throw new Error("Failed to load agents")
        }

        const models: ProviderModelItem[] = []
        for (const provider of providersResult.data.providers) {
          for (const model of Object.values(provider.models)) {
            models.push({
              chef: provider.name,
              chefSlug: provider.id,
              contextLimit: model.limit?.context,
              id: `${provider.id}:${model.id}`,
              modelID: model.id,
              name: model.name,
              providerID: provider.id,
              variants: model.variants ? Object.keys(model.variants) : undefined,
            })
          }
        }

        return {
          agent: agentsResult.data.find((item) => item.name === agentName),
          chefs: [...new Set(models.map((item) => item.chef))],
          config: configResult.data,
          models,
          providerDefaults: providersResult.data.default,
        }
      },
      staleTime: 60_000,
    })
  )
  const catalog = modelCatalog.data

  const models = useMemo(() => catalog?.models ?? [], [catalog?.models])
  const chefs = useMemo(() => catalog?.chefs ?? [], [catalog?.chefs])
  const sessionModel = session?.model
  const agentModel = catalog?.agent?.model
  const selectedModel = (() => {
    const explicitModel = model ? models.find((item) => item.id === model) : undefined
    if (explicitModel) return explicitModel

    if (sessionModel) {
      const match = models.find((item) => {
        return item.providerID === sessionModel.providerID && item.modelID === sessionModel.id
      })
      if (match) return match
    }

    if (agentModel) {
      const match = models.find((item) => {
        return item.providerID === agentModel.providerID && item.modelID === agentModel.modelID
      })
      if (match) return match
    }

    if (catalog?.config.model) {
      const [providerID, ...modelID] = catalog.config.model.split("/")
      const match = models.find((item) => {
        return item.providerID === providerID && item.modelID === modelID.join("/")
      })
      if (match) return match
    }

    for (const storedModel of recent) {
      const match = models.find((item) => {
        return item.providerID === storedModel.providerID && item.modelID === storedModel.modelID
      })
      if (match) return match
    }

    const providerDefaults = catalog?.providerDefaults ?? {}
    for (const provider of Object.keys(providerDefaults)) {
      const modelID = providerDefaults[provider]
      if (!modelID) continue
      const match = models.find((item) => {
        return item.providerID === provider && item.modelID === modelID
      })
      if (match) return match
    }

    return models[0]
  })()
  const selectedModelID = selectedModel?.id ?? ""
  const reasoningVariants = selectedModel?.variants ?? []
  let fallbackReasoningLevel = DEFAULT_REASONING_LEVEL
  if (selectedModel && reasoningVariants.length > 0) {
    const variants = new Set(reasoningVariants)
    if (
      sessionModel?.providerID === selectedModel.providerID &&
      sessionModel.id === selectedModel.modelID &&
      sessionModel.variant &&
      variants.has(sessionModel.variant)
    ) {
      fallbackReasoningLevel = sessionModel.variant
    } else if (
      agentModel?.providerID === selectedModel.providerID &&
      agentModel.modelID === selectedModel.modelID &&
      catalog?.agent?.variant &&
      variants.has(catalog.agent.variant)
    ) {
      fallbackReasoningLevel = catalog.agent.variant
    } else {
      const storedVariant = getVariant({
        modelID: selectedModel.modelID,
        providerID: selectedModel.providerID,
      })
      if (storedVariant && variants.has(storedVariant)) {
        fallbackReasoningLevel = storedVariant
      }
    }
  }
  const selectedReasoningLevel =
    reasoningVariants.length === 0
      ? DEFAULT_REASONING_LEVEL
      : reasoningLevel !== DEFAULT_REASONING_LEVEL && reasoningVariants.includes(reasoningLevel)
        ? reasoningLevel
        : fallbackReasoningLevel
  const selectedReasoningVariant =
    selectedReasoningLevel === DEFAULT_REASONING_LEVEL ? undefined : selectedReasoningLevel

  // Reverted turns are dropped on the next prompt, so exclude them from the
  // context/cost indicator.
  const revertMessageID = session?.revert?.messageID
  const contextMessages = revertMessageID
    ? messages.filter((message) => message.id < revertMessageID)
    : messages
  const contextUsage = getAssistantUsage(contextMessages, models)
  const { abortMessage, canSubmit, sendMessage, sendState } = useOpencodeSend(
    agentName,
    activeSessionId,
    isBusy || blocked || agentReadiness.isGettingReady,
    setPromotedSessionId
  )

  useEffect(() => {
    if (models.length === 0 || !modelStorageReady) return
    clearInvalid((storedModel) => {
      return models.some((item) => {
        return item.providerID === storedModel.providerID && item.modelID === storedModel.modelID
      })
    })
  }, [clearInvalid, modelStorageReady, models])

  const { isPending: isQuestionPending, mutateAsync: submitQuestionAnswer } = useMutation({
    mutationFn: async (answers: QuestionAnswer[]) => {
      if (!questionRequest) {
        throw new Error("No question request is active")
      }
      const client = await createAgentOpencodeClient(agentName)
      const result = await client.question.reply({
        answers,
        requestID: questionRequest.id,
      })
      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to answer question"))
      }
    },
    onError: (error) => {
      toast.error("Couldn't submit answers", {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const { isPending: isQuestionRejectPending, mutateAsync: rejectQuestion } = useMutation({
    mutationFn: async () => {
      if (!questionRequest) {
        throw new Error("No question request is active")
      }
      const client = await createAgentOpencodeClient(agentName)
      const result = await client.question.reject({
        requestID: questionRequest.id,
      })
      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to reject question"))
      }
    },
    onError: (error) => {
      toast.error("Couldn't dismiss question", {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  const { isPending: isPermissionPending, mutateAsync: replyPermission } = useMutation({
    mutationFn: async (reply: PermissionDecision) => {
      if (!permissionRequest) {
        throw new Error("No permission request is active")
      }
      const client = await createAgentOpencodeClient(agentName)
      const result = await client.permission.reply({
        requestID: permissionRequest.id,
        reply,
      })
      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to respond to permission"))
      }
    },
    onError: (error) => {
      toast.error("Couldn't reply to permission", {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  // Fold the echoed session into the live store for an instant update; the
  // matching session.updated stream event reconciles it (see applyOptimisticSession).
  const applyRevert = useCallback(
    async (messageID?: string) => {
      if (!activeSessionId) return
      const client = await createAgentOpencodeClient(agentName)
      const result = messageID
        ? await client.session.revert({ directory, messageID, sessionID: activeSessionId })
        : await client.session.unrevert({ directory, sessionID: activeSessionId })
      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to update session"))
      }
      applyOptimisticSession(result.data)
    },
    [activeSessionId, agentName, applyOptimisticSession, directory]
  )

  // A resendable composer draft (non-synthetic text + file attachments) for a
  // stored user turn.
  const composerMessageFor = useCallback(
    (messageID: string): PromptInputMessage => {
      const parts = partsByMessage[messageID] ?? []
      const text = parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
        .filter((part) => part.synthetic !== true)
        .map((part) => textByPart[part.id] ?? part.text)
        .join("")
      const files = parts
        .filter((part): part is Extract<Part, { type: "file" }> => part.type === "file")
        .map((part) => ({
          filename: part.filename,
          mediaType: part.mime,
          type: "file" as const,
          url: part.url,
        }))
      return { files, text }
    },
    [partsByMessage, textByPart]
  )

  const { isPending: isReverting, mutate: revertMessage } = useMutation({
    mutationFn: applyRevert,
    onError: (error) => {
      toast.error("Couldn't revert message", {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  // Reverting stages the rolled-back turn's prompt in the composer to edit/resend.
  const handleRevert = useCallback(
    (messageID: string) => {
      composerRef.current?.setMessage(composerMessageFor(messageID))
      revertMessage(messageID)
    },
    [composerMessageFor, revertMessage]
  )

  // Restoring advances the revert boundary one user turn (or clears it on the
  // newest), keeping the composer staged to the oldest still-reverted turn.
  const restoreMutation = useMutation({
    mutationFn: (messageID: string) => {
      const next = messages.find((message) => message.role === "user" && message.id > messageID)
      composerRef.current?.setMessage(next ? composerMessageFor(next.id) : { files: [], text: "" })
      return applyRevert(next?.id)
    },
    onError: (error) => {
      toast.error("Couldn't restore message", {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })
  const restoringId = restoreMutation.isPending ? restoreMutation.variables : undefined
  // Sending must wait for a revert/restore to apply, else the prompt can race
  // ahead and run against the not-yet-reverted session, appending in place of
  // replacing the selected turn.
  const revertPending = isReverting || restoreMutation.isPending

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (agentReadiness.isGettingReady) return
      if (!messageHasRenderableContent(message.text, message.files)) {
        toast.error("Message cannot be empty")
        return
      }
      await sendMessage({
        files: message.files,
        model: selectedModel,
        sessionID: activeSessionId,
        text: message.text,
        variant: selectedReasoningVariant,
      })
      if (!selectedModel) return
      pushRecent({
        modelID: selectedModel.modelID,
        providerID: selectedModel.providerID,
      })
    },
    [
      activeSessionId,
      agentReadiness.isGettingReady,
      pushRecent,
      selectedModel,
      selectedReasoningVariant,
      sendMessage,
    ]
  )

  const handleModelSelect = useCallback((modelId: string) => {
    setModel(modelId)
    setReasoningLevel(DEFAULT_REASONING_LEVEL)
    setModelSelectorOpen(false)
  }, [])

  const handleReasoningLevelChange = useCallback(
    (value: string) => {
      setReasoningLevel(value)
      if (!selectedModel) return
      setVariant(
        { modelID: selectedModel.modelID, providerID: selectedModel.providerID },
        value === DEFAULT_REASONING_LEVEL ? undefined : value
      )
    },
    [selectedModel, setVariant]
  )

  const handlePermission = useCallback(
    (reply: PermissionDecision) => {
      void replyPermission(reply)
    },
    [replyPermission]
  )

  const { reverted, rows } = useMemo(
    () =>
      projectTimeline({
        historyError,
        isBusy,
        localMessages,
        messages,
        partsByMessage,
        revertMessageID: session?.revert?.messageID,
        sessionStatus,
        streamError,
        textByPart,
      }),
    [
      historyError,
      isBusy,
      localMessages,
      messages,
      partsByMessage,
      session?.revert?.messageID,
      sessionStatus,
      streamError,
      textByPart,
    ]
  )
  const inputDisabled = blocked || isBusy || agentReadiness.isGettingReady
  const showStarter = !activeSessionId && !isPending && rows.length === 0
  const showHistorySkeleton = isPending && rows.length === 0 && !showStarter

  return (
    <div className="absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden">
      {isBusy ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5"
          data-component="session-progress"
          data-state="showing"
        >
          <div data-component="session-progress-bar" />
        </div>
      ) : null}
      <Conversation
        className={cn(
          "transition-opacity duration-200",
          showStarter && "pointer-events-none opacity-0"
        )}
      >
        <ConversationContent className="mx-auto w-full max-w-3xl px-4 py-6">
          {showHistorySkeleton ? (
            <div className="flex w-full flex-col gap-3">
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-16 w-2/3 rounded-md" />
            </div>
          ) : !showStarter ? (
            <>
              <div className="flex w-full flex-col gap-4">
                {rows.map((row) => (
                  <TimelineRowView
                    agentName={agentName}
                    isBusy={isBusy}
                    isLastBlock={rows.at(-1)?.key === row.key}
                    key={row.key}
                    onRetryHistory={reloadHistory}
                    onRetryStream={reconnectStream}
                    onRevert={handleRevert}
                    revertDisabled={isBusy || revertPending}
                    row={row}
                  />
                ))}
                <AgentWorkingIndicator isWorking={isBusy} />
              </div>
              <RevertDock
                items={reverted}
                onRestore={restoreMutation.mutate}
                pending={revertPending}
                restoringId={restoringId}
                summary={session?.summary}
              />
              {todos.length > 0 ? <TodoDock todos={todos} /> : null}
              {permissionRequest ? (
                <PermissionDock
                  onDecide={handlePermission}
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
          ) : null}
        </ConversationContent>
        {!showStarter ? <ConversationScrollButton /> : null}
      </Conversation>
      <motion.div
        className={cn(
          "grid gap-4",
          showStarter ? "absolute inset-x-0 top-1/2 -translate-y-1/2 px-4" : "shrink-0 pt-4"
        )}
        layout
        transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      >
        <div
          className={cn(
            "mx-auto flex w-full flex-col",
            showStarter ? "max-w-3xl gap-8" : "min-w-0 gap-4 px-4 pb-4 lg:w-4/5 lg:px-0"
          )}
        >
          {showStarter ? (
            <NewSessionGreeting firstName={firstName} greetingIndex={greetingIndex} />
          ) : null}
          <PromptInput
            accept={chatAttachmentConfig.accept}
            controllerRef={composerRef}
            globalDrop
            maxFileSize={chatAttachmentConfig.maxFileSizeBytes}
            maxFiles={chatAttachmentConfig.maxFileCount}
            multiple
            onError={(error) => {
              toast.error(error.message || chatAttachmentErrorMessage(error.code))
            }}
            onSubmit={handleSubmit}
          >
            <PromptInputAttachmentsDisplay />
            <PromptInputBody>
              <motion.div
                className="col-start-1 row-start-1 group-data-[multiline=true]/prompt-body:row-start-2"
                layout="position"
                transition={promptShiftTransition}
              >
                <PromptInputAttachmentButton disabled={inputDisabled} />
              </motion.div>
              <PromptInputTextarea
                className="col-start-2 row-start-1 group-data-[multiline=true]/prompt-body:col-span-full group-data-[multiline=true]/prompt-body:col-start-1"
                disabled={inputDisabled}
              />
              <div className="contents">
                <motion.div
                  className="col-start-3 row-start-1 group-data-[multiline=true]/prompt-body:row-start-2"
                  layout="position"
                  transition={promptShiftTransition}
                >
                  <ModelSelector
                    onOpenChange={setModelSelectorOpen}
                    open={agentReadiness.isGettingReady ? false : modelSelectorOpen}
                  >
                    <div className="hidden min-w-0 items-center justify-end gap-1.5 @xl/chat:flex">
                      <ModelSelectorTrigger asChild>
                        <PromptInputButton
                          className="h-8 max-w-72 justify-start px-2"
                          disabled={inputDisabled}
                        >
                          {agentReadiness.isGettingReady ? (
                            <AgentGettingReady />
                          ) : selectedModel?.chefSlug ? (
                            <ModelSelectorLogo provider={selectedModel.chefSlug} />
                          ) : null}
                          {agentReadiness.isGettingReady ? null : selectedModel?.name ? (
                            <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
                          ) : (
                            <ModelSelectorName>Model</ModelSelectorName>
                          )}
                          {agentReadiness.isGettingReady ? null : (
                            <ChevronDownIcon data-icon="inline-end" />
                          )}
                        </PromptInputButton>
                      </ModelSelectorTrigger>
                      {!agentReadiness.isGettingReady &&
                      contextUsage?.maxTokens &&
                      contextUsage.maxTokens > 0 ? (
                        <Context
                          maxTokens={contextUsage.maxTokens}
                          totalCostUSD={sessionCost}
                          usage={contextUsage.usage}
                          usedTokens={contextUsage.usedTokens}
                        >
                          <ContextTrigger className="hover:bg-foreground/6 dark:hover:bg-foreground/10 aria-expanded:bg-foreground/8 dark:aria-expanded:bg-foreground/12 data-[state=open]:bg-foreground/8 dark:data-[state=open]:bg-foreground/12 gap-1 rounded-full px-2" />
                          <ContextContent>
                            <ContextContentHeader />
                            <ContextContentBody className="flex flex-col gap-2">
                              <ContextInputUsage />
                              <ContextOutputUsage />
                              <ContextReasoningUsage />
                              <ContextCacheUsage />
                            </ContextContentBody>
                            <ContextContentFooter />
                          </ContextContent>
                        </Context>
                      ) : null}
                      {!agentReadiness.isGettingReady && reasoningVariants.length > 0 ? (
                        <Select
                          disabled={inputDisabled}
                          onValueChange={handleReasoningLevelChange}
                          value={selectedReasoningLevel}
                        >
                          <ReasoningSelectTrigger
                            aria-label="Reasoning level"
                            className="data-[variant=ghost]:hover:bg-foreground/6 dark:data-[variant=ghost]:hover:bg-foreground/10 data-[variant=ghost]:aria-expanded:bg-foreground/8 dark:data-[variant=ghost]:aria-expanded:bg-foreground/12 data-[variant=ghost]:data-[state=open]:bg-foreground/8 dark:data-[variant=ghost]:data-[state=open]:bg-foreground/12 h-8 min-w-16 gap-1.5 px-2 data-[size=sm]:rounded-full"
                            size="sm"
                            variant="ghost"
                          >
                            <BrainCircuitIcon className="text-muted-foreground size-4" />
                            <SelectValue placeholder="Reasoning" />
                          </ReasoningSelectTrigger>
                          <SelectContent align="end" position="popper" side="top" sideOffset={8}>
                            <SelectGroup>
                              <SelectItem value={DEFAULT_REASONING_LEVEL}>Default</SelectItem>
                              {reasoningVariants.map((variant) => (
                                <SelectItem key={variant} value={variant}>
                                  {variant.length
                                    ? variant[0]?.toUpperCase() + variant.slice(1)
                                    : variant}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>
                    <div className="flex justify-end @xl/chat:hidden">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <PromptInputButton
                            aria-label="Chat options"
                            className="size-8"
                            disabled={agentReadiness.isGettingReady}
                          >
                            <Settings2Icon />
                          </PromptInputButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-72 max-w-[calc(100vw-2rem)]"
                          side="top"
                          sideOffset={8}
                        >
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              disabled={inputDisabled}
                              onSelect={() => setModelSelectorOpen(true)}
                            >
                              {selectedModel?.chefSlug ? (
                                <ModelSelectorLogo provider={selectedModel.chefSlug} />
                              ) : (
                                <BotIcon />
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                {selectedModel?.name ?? "Model"}
                              </span>
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          {reasoningVariants.length > 0 ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
                                <DropdownMenuRadioGroup
                                  onValueChange={handleReasoningLevelChange}
                                  value={selectedReasoningLevel}
                                >
                                  <DropdownMenuRadioItem
                                    disabled={inputDisabled}
                                    value={DEFAULT_REASONING_LEVEL}
                                  >
                                    Default
                                  </DropdownMenuRadioItem>
                                  {reasoningVariants.map((variant) => (
                                    <DropdownMenuRadioItem
                                      className="capitalize"
                                      disabled={inputDisabled}
                                      key={variant}
                                      value={variant}
                                    >
                                      {variant}
                                    </DropdownMenuRadioItem>
                                  ))}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuGroup>
                            </>
                          ) : null}
                          {contextUsage?.maxTokens && contextUsage.maxTokens > 0 ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>Context</DropdownMenuLabel>
                                <div className="px-1.5 py-1.5">
                                  <Context
                                    maxTokens={contextUsage.maxTokens}
                                    totalCostUSD={sessionCost}
                                    usage={contextUsage.usage}
                                    usedTokens={contextUsage.usedTokens}
                                  >
                                    <ContextContentHeader className="p-0" />
                                    <ContextContentBody className="flex flex-col gap-2 px-0 pt-2 pb-0">
                                      <ContextInputUsage />
                                      <ContextOutputUsage />
                                      <ContextReasoningUsage />
                                      <ContextCacheUsage />
                                    </ContextContentBody>
                                    <ContextContentFooter className="mt-2 rounded-md px-2 py-1.5" />
                                  </Context>
                                </div>
                              </DropdownMenuGroup>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <ModelSelectorContent>
                      <ModelSelectorInput placeholder="Search models..." />
                      <ModelSelectorList>
                        <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                        {chefs.map((chef) => (
                          <ModelSelectorGroup heading={chef} key={chef}>
                            {models
                              .filter((item) => item.chef === chef)
                              .map((item) => (
                                <ModelSelectorItem
                                  key={item.id}
                                  onSelect={handleModelSelect}
                                  value={item.id}
                                >
                                  <ModelSelectorLogo provider={item.chefSlug} />
                                  <ModelSelectorName>{item.name}</ModelSelectorName>
                                  <ModelSelectorLogoGroup>
                                    <ModelSelectorLogo
                                      key={item.providerID}
                                      provider={item.providerID}
                                    />
                                  </ModelSelectorLogoGroup>
                                  {selectedModelID === item.id ? (
                                    <CheckIcon className="ml-auto" />
                                  ) : (
                                    <div className="ml-auto size-4" />
                                  )}
                                </ModelSelectorItem>
                              ))}
                          </ModelSelectorGroup>
                        ))}
                      </ModelSelectorList>
                    </ModelSelectorContent>
                  </ModelSelector>
                </motion.div>
                <motion.div
                  className="col-start-4 row-start-1 group-data-[multiline=true]/prompt-body:row-start-2"
                  layout="position"
                  transition={promptShiftTransition}
                >
                  <PromptInputSubmit
                    className="size-9"
                    disabled={
                      blocked ||
                      agentReadiness.isGettingReady ||
                      revertPending ||
                      (!isBusy && (!selectedModel || !canSubmit))
                    }
                    onStop={isBusy ? () => void abortMessage(directory) : undefined}
                    status={isBusy ? "streaming" : sendState}
                  />
                </motion.div>
              </div>
            </PromptInputBody>
          </PromptInput>
        </div>
      </motion.div>
    </div>
  )
}

function MessageActionBar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
        className
      )}
    >
      {children}
    </div>
  )
}

function TimelineRowView({
  agentName,
  isBusy,
  isLastBlock,
  onRetryHistory,
  onRetryStream,
  onRevert,
  revertDisabled,
  row,
}: {
  agentName: string
  isBusy: boolean
  isLastBlock: boolean
  onRetryHistory: () => void
  onRetryStream: () => void
  onRevert: (messageID: string) => void
  revertDisabled: boolean
  row: TimelineRow
}) {
  switch (row.type) {
    case "local": {
      if (row.message.kind === "system") {
        return (
          <Message
            className="mx-auto w-full max-w-full items-center"
            from="assistant"
            key={row.key}
          >
            <MessageContent className="border-destructive/20 bg-destructive/5 text-destructive w-fit rounded-md border px-3 py-2">
              <MessageResponse>{row.message.content}</MessageResponse>
            </MessageContent>
          </Message>
        )
      }
      return (
        <Message from="user" key={row.key}>
          <MessageContent
            className={cn(
              row.message.status === "failed"
                ? "border-destructive/30 bg-destructive/10 text-destructive border"
                : undefined,
              row.message.attachments.length > 0 ? "space-y-3" : undefined
            )}
          >
            {row.message.attachments.length > 0 ? (
              <Attachments variant="inline">
                {row.message.attachments.map((attachment) => (
                  <Attachment data={attachment} key={attachment.id}>
                    <AttachmentPreview />
                  </Attachment>
                ))}
              </Attachments>
            ) : null}
            {row.message.text.length > 0 ? (
              <MessageResponse>{row.message.text}</MessageResponse>
            ) : null}
          </MessageContent>
        </Message>
      )
    }

    case "user": {
      const isEmpty = row.text.length === 0 && row.attachments.length === 0
      return (
        <Message from="user" key={row.key}>
          <MessageContent
            className={cn(
              row.attachments.length > 0 ? "space-y-3" : undefined,
              isEmpty ? "hidden" : undefined
            )}
          >
            {row.attachments.length > 0 ? (
              <Attachments variant="inline">
                {row.attachments.map((attachment) => (
                  <Attachment data={attachment} key={attachment.id}>
                    <AttachmentPreview />
                  </Attachment>
                ))}
              </Attachments>
            ) : null}
            {row.text.length > 0 ? <MessageResponse>{row.text}</MessageResponse> : null}
          </MessageContent>
          {isEmpty ? null : (
            <div className="ml-auto flex items-center gap-1">
              <MessageActionBar>
                <CopyButton content={row.text} />
                <Button
                  aria-label="Revert to here"
                  className="size-6"
                  disabled={revertDisabled}
                  onClick={() => onRevert(row.messageID)}
                  size="icon"
                  variant="ghost"
                >
                  <Undo2Icon />
                </Button>
              </MessageActionBar>
              <span className="text-muted-foreground text-xs">
                {formatMessageTime(row.createdAt)}
              </span>
            </div>
          )}
        </Message>
      )
    }

    case "assistant": {
      const groups = groupEntries(row.entries)
      const lastGroupIndex = groups.length - 1
      const copyText = row.entries
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.content)
        .join("\n\n")
      return (
        <Message from="assistant" key={row.key}>
          <MessageContent>
            {groups.map((group, groupIndex) => {
              switch (group.type) {
                case "text":
                  return <MessageResponse key={group.key}>{group.content}</MessageResponse>
                case "reasoning": {
                  const isStreaming = isBusy && isLastBlock && groupIndex === lastGroupIndex
                  return (
                    <Reasoning isStreaming={isStreaming} key={group.key}>
                      <ReasoningTrigger />
                      <ReasoningContent>{group.content}</ReasoningContent>
                    </Reasoning>
                  )
                }
                case "tool-group":
                  return (
                    <div
                      className="bg-muted dark:bg-card max-w-full min-w-0 overflow-hidden rounded-md p-2"
                      key={group.key}
                    >
                      {group.entries.map((entry) => {
                        const toolEntry = entry.toolEntries[0]
                        if (!toolEntry) return null
                        return (
                          <ToolEntries agentName={agentName} entry={toolEntry} key={entry.key} />
                        )
                      })}
                    </div>
                  )
                default:
                  return null
              }
            })}
          </MessageContent>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground text-xs">
              {formatMessageTime(row.createdAt)}
            </span>
            {copyText.length > 0 && !(isBusy && isLastBlock) ? (
              <MessageActionBar>
                <CopyButton content={copyText} />
              </MessageActionBar>
            ) : null}
          </div>
        </Message>
      )
    }

    case "thinking": {
      return (
        <div className="text-muted-foreground text-sm" key={row.key}>
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-3.5" />
            <span className="animate-pulse">Thinking...</span>
          </span>
        </div>
      )
    }

    case "retry": {
      return (
        <RetryCountdown attempt={row.attempt} key={row.key} message={row.message} next={row.next} />
      )
    }

    case "diff-summary": {
      const visible = row.diffs.slice(0, 10)
      return (
        <Accordion className="w-full" key={row.key} type="multiple">
          {visible.map((diff) => {
            const value = diff.file ?? diff.patch ?? ""
            const path = value.replace(/\\/g, "/")
            const slash = path.lastIndexOf("/")
            const stat =
              diff.status === "added"
                ? "Added"
                : diff.status === "deleted"
                  ? "Deleted"
                  : `+${diff.additions} -${diff.deletions}`
            return (
              <AccordionItem key={`${value}:${diff.status ?? "modified"}`} value={value}>
                <AccordionTrigger className="gap-3 py-1.5 hover:no-underline">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {slash >= 0 ? path.slice(slash + 1) : path}
                    </div>
                    {value.includes("/") ? (
                      <div className="text-muted-foreground truncate text-xs">
                        {slash > 0 ? path.slice(0, slash) : "/"}
                      </div>
                    ) : null}
                  </div>
                  <Badge variant="outline">{stat}</Badge>
                </AccordionTrigger>
                <AccordionContent>
                  {diff.patch ? (
                    <pre className="max-w-full overflow-auto font-mono text-xs wrap-break-word whitespace-pre-wrap">
                      {diff.patch}
                    </pre>
                  ) : (
                    <div className="text-muted-foreground font-mono text-xs">
                      +{diff.additions} -{diff.deletions}
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            )
          })}
          {row.diffs.length > visible.length ? (
            <div className="text-muted-foreground py-1 text-xs">
              +{row.diffs.length - visible.length} more
            </div>
          ) : null}
          {row.title ? <div className="text-foreground pb-1 text-sm">{row.title}</div> : null}
          {row.body ? <MessageResponse>{row.body}</MessageResponse> : null}
        </Accordion>
      )
    }

    case "divider": {
      return (
        <div className="text-muted-foreground flex items-center gap-3 py-2 text-xs" key={row.key}>
          <div className="bg-border h-px flex-1" />
          <span className="font-medium tracking-wide uppercase">
            {row.variant === "compaction" ? "Context compacted" : "Interrupted"}
          </span>
          <div className="bg-border h-px flex-1" />
        </div>
      )
    }

    case "error": {
      return (
        <Alert key={row.key} variant="destructive">
          <AlertTitle>{row.label}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{row.body}</span>
            <Button
              onClick={row.kind === "history" ? onRetryHistory : onRetryStream}
              size="sm"
              type="button"
              variant="secondary"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )
    }

    case "assistant-error": {
      return (
        <Alert key={row.key} variant="destructive">
          <AlertTitle>{row.label}</AlertTitle>
          <AlertDescription>{row.body}</AlertDescription>
        </Alert>
      )
    }
  }
}

export default function Chat(props: ChatProps) {
  return <ChatInner key={`${props.agentName}:${props.sessionId ?? "new"}`} {...props} />
}
