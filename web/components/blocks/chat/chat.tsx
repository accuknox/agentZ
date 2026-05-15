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
import { Spinner } from "@/components/ui/spinner"
import { ToolEntries, toolEntries } from "@/components/blocks/chat/tool-parts"
import { type LocalChatMessage, useOpencodeChat } from "@/components/blocks/chat/use-opencode-chat"
import { useOpencodeSend } from "@/components/blocks/chat/use-opencode-send"
import { listAgentProvidersAction } from "@/data/opencode.actions"
import type { ProviderModelItem } from "@/data/types"
import type { Message as OpencodeMessage, Part } from "@opencode-ai/sdk"
import { CheckIcon } from "lucide-react"
import { startTransition, useActionState, useCallback, useEffect, useMemo, useState } from "react"
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
  sessionId?: string
}

const DEFAULT_REASONING_LEVEL = "__default__"

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
    historyError,
    isBusy,
    isPending,
    localMessages,
    messages,
    partsByMessage,
    streamError,
    textByPart,
  } = useOpencodeChat(agentName, sessionId)
  const [model, setModel] = useState<string>("")
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [reasoningLevel, setReasoningLevel] = useState<string>(DEFAULT_REASONING_LEVEL)

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
    isBusy
  )

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

  const lastBlock = renderBlocks.at(-1)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {isBusy && (
        <div aria-hidden="true" data-component="session-progress" data-state="showing">
          <div data-component="session-progress-bar" />
        </div>
      )}
      <Conversation>
        <ConversationContent className="mx-auto w-full px-4 lg:w-4/5 lg:px-0">
          {isPending ? (
            <div className="flex min-h-48 items-center justify-center">
              <Spinner aria-label="Loading session messages" />
            </div>
          ) : (
            <>
              {renderBlocks.map((block) => {
                if ("message" in block) {
                  if (block.message.kind === "system") {
                    return (
                      <Message
                        className="mx-auto w-full max-w-full items-center"
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

                return (
                  <Message from={block.from} key={block.key}>
                    <MessageContent>
                      {groups.map((group, groupIndex) => {
                        if (group.type === "text") {
                          return <MessageResponse key={group.key}>{group.content}</MessageResponse>
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
                            <div className="rounded-md bg-muted p-2 dark:bg-card" key={group.key}>
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
                )
              })}
              <AgentWorkingIndicator isWorking={isBusy} />
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
              <PromptInputTextarea />
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
                        className="h-8 min-w-32 gap-1 px-2 text-xs"
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
                disabled={!selectedModel || !canSubmit}
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
