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
import { AgentWorkingIndicator } from "@/components/agent-working-indicator"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import {
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
  TodoDock,
} from "@/components/blocks/chat/docks"
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
import { cn } from "@/lib/utils"
import type { Message as OpencodeMessage, QuestionAnswer } from "@opencode-ai/sdk/v2"
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { CheckIcon, PaperclipIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
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
  SelectItem,
  SelectTrigger as ReasoningSelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { LanguageModelUsage } from "ai"

type ChatProps = {
  agentName: string
  firstName?: string
  sessionId?: string
}

const DEFAULT_REASONING_LEVEL = "__default__"

// RetryCountdown ticks every second while the SessionStatus.retry "next"
// timestamp is in the future.
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

type AgentSelectionConfig = {
  model?: {
    modelID: string
    providerID: string
  }
  variant?: string
}

type ModelCatalog = {
  agent?: AgentSelectionConfig
  chefs: string[]
  config: {
    model?: string
  }
  models: ProviderModelItem[]
  providerDefaults: Record<string, string>
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
  return undefined
}

function PromptInputAttachmentsDisplay() {
  const attachments = usePromptInputAttachments()

  if (attachments.files.length === 0) {
    return null
  }

  return (
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
  )
}

function PromptInputAttachmentButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments()

  return (
    <PromptInputButton
      aria-label="Add attachment"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      tooltip="Add attachment"
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  )
}

// Groups consecutive tool entries so they share one indentation block in the
// timeline; text and reasoning entries stay standalone. Mirrors opencode's
// part-grouping but omits the sticky-accordion offset that the desktop timeline
// uses — the web chat has no parallel side rail to keep anchored.
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

function ChatInner({ agentName, firstName, sessionId }: ChatProps) {
  const {
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
  } = useOpencodeChat(agentName, sessionId)
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
  const selectedSessionModel = useMemo(() => {
    if (!sessionModel) return undefined
    return models.find((item) => {
      return item.providerID === sessionModel.providerID && item.modelID === sessionModel.id
    })
  }, [models, sessionModel])
  const selectedAgentModel = useMemo(() => {
    const agentModel = catalog?.agent?.model
    if (!agentModel) return undefined
    return models.find((item) => {
      return item.providerID === agentModel.providerID && item.modelID === agentModel.modelID
    })
  }, [catalog?.agent?.model, models])
  const selectedConfigModel = useMemo(() => {
    const configModel = catalog?.config.model
    if (!configModel) return undefined
    const [providerID, ...modelID] = configModel.split("/")
    if (!providerID || modelID.length === 0) return undefined
    return models.find((item) => {
      return item.providerID === providerID && item.modelID === modelID.join("/")
    })
  }, [catalog?.config.model, models])
  const selectedRecentModel = useMemo(() => {
    for (const storedModel of recent) {
      const match = models.find((item) => {
        return item.providerID === storedModel.providerID && item.modelID === storedModel.modelID
      })
      if (match) return match
    }
    return undefined
  }, [models, recent])
  const selectedProviderDefaultModel = useMemo(() => {
    const providerDefaults = catalog?.providerDefaults ?? {}
    for (const provider of Object.keys(providerDefaults)) {
      const modelID = providerDefaults[provider]
      if (!modelID) continue
      const match = models.find((item) => {
        return item.providerID === provider && item.modelID === modelID
      })
      if (match) return match
    }
    return undefined
  }, [catalog?.providerDefaults, models])
  const fallbackModel = useMemo(() => {
    return (
      selectedSessionModel ??
      selectedAgentModel ??
      selectedConfigModel ??
      selectedRecentModel ??
      selectedProviderDefaultModel ??
      models[0]
    )
  }, [
    models,
    selectedAgentModel,
    selectedConfigModel,
    selectedProviderDefaultModel,
    selectedRecentModel,
    selectedSessionModel,
  ])
  const selectedModel = useMemo(() => {
    if (model) {
      const explicitModel = models.find((item) => item.id === model)
      if (explicitModel) return explicitModel
    }
    return fallbackModel
  }, [fallbackModel, model, models])
  const selectedModelID = selectedModel?.id ?? ""
  const reasoningVariants = useMemo(() => selectedModel?.variants ?? [], [selectedModel?.variants])
  const fallbackReasoningLevel = useMemo(() => {
    if (!selectedModel || reasoningVariants.length === 0) return DEFAULT_REASONING_LEVEL
    const variants = new Set(reasoningVariants)
    const sameAsSessionModel =
      selectedSessionModel?.providerID === selectedModel.providerID &&
      selectedSessionModel.modelID === selectedModel.modelID
    if (sameAsSessionModel && session?.model?.variant && variants.has(session.model.variant)) {
      return session.model.variant
    }
    const sameAsAgentModel =
      selectedAgentModel?.providerID === selectedModel.providerID &&
      selectedAgentModel.modelID === selectedModel.modelID
    if (sameAsAgentModel && catalog?.agent?.variant && variants.has(catalog.agent.variant)) {
      return catalog.agent.variant
    }
    const storedVariant = getVariant({
      modelID: selectedModel.modelID,
      providerID: selectedModel.providerID,
    })
    if (storedVariant && variants.has(storedVariant)) {
      return storedVariant
    }
    return DEFAULT_REASONING_LEVEL
  }, [
    catalog,
    getVariant,
    reasoningVariants,
    selectedAgentModel,
    selectedModel,
    selectedSessionModel,
    session,
  ])
  const selectedReasoningLevel = useMemo(() => {
    if (reasoningVariants.length === 0) return DEFAULT_REASONING_LEVEL
    if (reasoningLevel !== DEFAULT_REASONING_LEVEL && reasoningVariants.includes(reasoningLevel)) {
      return reasoningLevel
    }
    return fallbackReasoningLevel
  }, [fallbackReasoningLevel, reasoningLevel, reasoningVariants])
  const selectedReasoningVariant = useMemo(() => {
    return selectedReasoningLevel === DEFAULT_REASONING_LEVEL ? undefined : selectedReasoningLevel
  }, [selectedReasoningLevel])

  const contextUsage = useMemo(() => {
    return getAssistantUsage(messages, models)
  }, [messages, models])
  const { abortMessage, canSubmit, sendMessage, sendState } = useOpencodeSend(
    agentName,
    sessionId,
    isBusy || blocked
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

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!messageHasRenderableContent(message.text, message.files)) {
        toast.error("Message cannot be empty")
        return
      }
      await sendMessage({
        files: message.files,
        model: selectedModel,
        sessionID: sessionId,
        text: message.text,
        variant: selectedReasoningVariant,
      })
      if (!selectedModel) return
      pushRecent({
        modelID: selectedModel.modelID,
        providerID: selectedModel.providerID,
      })
    },
    [pushRecent, selectedModel, selectedReasoningVariant, sendMessage, sessionId]
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

  const rows = useMemo(
    () =>
      projectTimeline({
        historyError,
        isBusy,
        localMessages,
        messages,
        partsByMessage,
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
      sessionStatus,
      streamError,
      textByPart,
    ]
  )
  const inputDisabled = blocked || isBusy
  const showGreeting = !sessionId && !isPending && rows.length === 0

  return (
    <div className="absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden">
      {isBusy ? (
        <div
          aria-hidden="true"
          className="bg-primary/40 absolute inset-x-0 top-0 h-0.5 animate-pulse"
          data-component="session-progress"
          data-state="showing"
        />
      ) : null}
      <Conversation>
        <ConversationContent className="w-full px-4">
          {isPending ? (
            <div className="mx-auto flex w-full flex-col gap-3 lg:w-4/5">
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-16 w-2/3 rounded-md" />
            </div>
          ) : showGreeting ? (
            <NewSessionGreeting firstName={firstName} />
          ) : (
            <>
              <div className="mx-auto flex w-full flex-col gap-4 lg:w-4/5">
                {rows.map((row) => (
                  <TimelineRowView
                    agentName={agentName}
                    isBusy={isBusy}
                    isLastBlock={rows.at(-1)?.key === row.key}
                    key={row.key}
                    onRetryHistory={reloadHistory}
                    onRetryStream={reconnectStream}
                    row={row}
                  />
                ))}
                <AgentWorkingIndicator isWorking={isBusy} />
              </div>
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
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 pt-4">
        <div className="mx-auto w-full px-4 pb-4 lg:w-4/5 lg:px-0">
          <PromptInput
            accept={chatAttachmentConfig.accept}
            globalDrop
            maxFileSize={chatAttachmentConfig.maxFileSizeBytes}
            maxFiles={chatAttachmentConfig.maxFileCount}
            multiple
            onError={(error) => {
              toast.error(error.message || chatAttachmentErrorMessage(error.code))
            }}
            onSubmit={handleSubmit}
          >
            <PromptInputHeader>
              <PromptInputAttachmentsDisplay />
            </PromptInputHeader>
            <PromptInputBody>
              <PromptInputTextarea disabled={inputDisabled} />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputAttachmentButton disabled={inputDisabled} />
                <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
                  <ModelSelectorTrigger asChild>
                    <PromptInputButton disabled={inputDisabled}>
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
                                  <CheckIcon className="ml-auto size-4" />
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
                {contextUsage?.maxTokens && contextUsage.maxTokens > 0 ? (
                  <Context
                    maxTokens={contextUsage.maxTokens}
                    totalCostUSD={sessionCost}
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
                  <Select
                    disabled={inputDisabled}
                    onValueChange={handleReasoningLevelChange}
                    value={selectedReasoningLevel}
                  >
                    <ReasoningSelectTrigger
                      aria-label="Reasoning level"
                      className="h-8 min-w-16 gap-1 px-2"
                      size="sm"
                      variant="ghost"
                    >
                      <SelectValue placeholder="Reasoning" />
                    </ReasoningSelectTrigger>
                    <SelectContent align="end" position="popper" side="top" sideOffset={8}>
                      <SelectItem value={DEFAULT_REASONING_LEVEL}>Default</SelectItem>
                      {reasoningVariants.map((variant) => (
                        <SelectItem key={variant} value={variant}>
                          {variant.length ? variant[0]?.toUpperCase() + variant.slice(1) : variant}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </PromptInputTools>
              <PromptInputSubmit
                disabled={blocked || (!isBusy && (!selectedModel || !canSubmit))}
                onStop={isBusy ? () => void abortMessage(directory) : undefined}
                status={isBusy ? "streaming" : sendState}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  )
}

function TimelineRowView({
  agentName,
  isBusy,
  isLastBlock,
  onRetryHistory,
  onRetryStream,
  row,
}: {
  agentName: string
  isBusy: boolean
  isLastBlock: boolean
  onRetryHistory: () => void
  onRetryStream: () => void
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
      return (
        <Message from="user" key={row.key}>
          <MessageContent
            className={cn(
              row.attachments.length > 0 ? "space-y-3" : undefined,
              row.text.length === 0 && row.attachments.length === 0 ? "hidden" : undefined
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
        </Message>
      )
    }

    case "assistant": {
      const groups = groupEntries(row.entries)
      const lastGroupIndex = groups.length - 1
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
                    <div className="bg-muted dark:bg-card rounded-md p-2" key={group.key}>
                      {group.entries.map((entry) => {
                        const toolEntry = entry.toolEntries[0]
                        if (!toolEntry) return null
                        // tool-parts.tsx consumes our ToolEntry shape directly;
                        // each group entry holds exactly one ToolEntry (either
                        // a single tool or a context-tool cluster).
                        const bridged =
                          toolEntry.type === "tool"
                            ? {
                                key: toolEntry.part.id,
                                part: toolEntry.part,
                                type: "tool" as const,
                              }
                            : {
                                key: toolEntry.parts.map((part) => part.id).join(":"),
                                parts: toolEntry.parts,
                                type: "context" as const,
                              }
                        return <ToolEntries agentName={agentName} entry={bridged} key={entry.key} />
                      })}
                    </div>
                  )
                default:
                  return null
              }
            })}
          </MessageContent>
        </Message>
      )
    }

    case "thinking": {
      return (
        <div className="text-muted-foreground text-sm" key={row.key}>
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-3.5" />
            <span className="animate-pulse">Thinking…</span>
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
            const normalized = value.replace(/\\/g, "/")
            const slash = normalized.lastIndexOf("/")
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
                      {slash >= 0 ? normalized.slice(slash + 1) : normalized}
                    </div>
                    {value.includes("/") ? (
                      <div className="text-muted-foreground truncate text-xs">
                        {slash > 0 ? normalized.slice(0, slash) : "/"}
                      </div>
                    ) : null}
                  </div>
                  <Badge variant="outline">{stat}</Badge>
                </AccordionTrigger>
                <AccordionContent>
                  {diff.patch ? (
                    <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap">
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
