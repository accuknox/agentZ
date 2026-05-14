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
import { useOpencodeChat } from "@/components/blocks/chat/use-opencode-chat"
import type { Message as OpencodeMessage, Part } from "@opencode-ai/sdk/v2"
import { CheckIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
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

type ChatProps = {
  agentName: string
  sessionId?: string
}

const models = [
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    providers: ["openai", "azure"],
  },
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    providers: ["openai", "azure"],
  },
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-opus-4-20250514",
    name: "Claude 4 Opus",
    providers: ["anthropic", "azure", "google", "amazon-bedrock"],
  },
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet",
    providers: ["anthropic", "azure", "google", "amazon-bedrock"],
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "gemini-2.0-flash-exp",
    name: "Gemini 2.0 Flash",
    providers: ["google"],
  },
]

const chefs = ["OpenAI", "Anthropic", "Google"]

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
  entries: RenderEntry[]
  from: OpencodeMessage["role"]
  key: string
}

type RenderBlock = {
  entries: RenderEntry[]
  from: OpencodeMessage["role"]
  key: string
}

type ToolRenderEntry = Extract<RenderEntry, { type: "tool" }>

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
  model: (typeof models)[number]
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
        {model.providers.map((provider) => (
          <ModelSelectorLogo key={provider} provider={provider} />
        ))}
      </ModelSelectorLogoGroup>
      {isSelected ? <CheckIcon className="ml-auto size-4" /> : <div className="ml-auto size-4" />}
    </ModelSelectorItem>
  )
}

function ChatInner({ agentName, sessionId }: ChatProps) {
  const { isPending, messages, partsByMessage, sessionStatus, textByPart } = useOpencodeChat(
    agentName,
    sessionId
  )
  const [model, setModel] = useState<string>(models[0].id)
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)

  const handleSubmit = useCallback((_: PromptInputMessage) => {}, [])

  const handleModelSelect = useCallback((modelId: string) => {
    setModel(modelId)
    setModelSelectorOpen(false)
  }, [])

  const selectedModel = useMemo(() => {
    return models.find((item) => item.id === model)
  }, [model])

  const visibleMessages = messages.filter((message) => {
    const parts = partsByMessage[message.id] ?? []
    return renderEntries(parts, textByPart).length > 0
  })
  const renderMessages: RenderMessage[] = visibleMessages.map((message) => {
    const parts = partsByMessage[message.id] ?? []
    const entries = renderEntries(parts, textByPart)

    return {
      entries,
      from: message.role,
      key: message.id,
    }
  })

  const isBusy = sessionStatus?.type === "busy"
  const renderBlocks: RenderBlock[] = []
  let assistantBlock: RenderBlock | undefined

  function flushAssistantBlock() {
    if (!assistantBlock) {
      return
    }

    renderBlocks.push(assistantBlock)
    assistantBlock = undefined
  }

  for (const message of renderMessages) {
    if (message.from === "assistant") {
      if (!assistantBlock) {
        assistantBlock = {
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
      entries: message.entries,
      from: message.from,
      key: message.key,
    })
  }

  flushAssistantBlock()

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
                                isSelected={model === item.id}
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
              </PromptInputTools>
              <PromptInputSubmit disabled status={isBusy ? "streaming" : "ready"} />
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
