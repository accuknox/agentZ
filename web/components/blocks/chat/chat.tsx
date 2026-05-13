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
import {
  Message,
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
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
import { textParts, useOpencodeChat } from "@/components/blocks/chat/use-opencode-chat"
import type { Message as OpencodeMessage } from "@opencode-ai/sdk/v2"
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

function messageText(
  message: OpencodeMessage,
  partsByMessage: Record<string, import("@opencode-ai/sdk/v2").Part[]>,
  textByPart: Record<string, string>
) {
  const parts = partsByMessage[message.id] ?? []

  return textParts(parts, textByPart)
    .map((part) => textByPart[part.id] ?? part.text)
    .join("")
}

type RenderMessage = {
  from: OpencodeMessage["role"]
  key: string
  versions: {
    id: string
    content: string
  }[]
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

  const handleSubmit = useCallback((_: PromptInputMessage) => {
    // Sending real prompts is intentionally deferred to the next slice.
  }, [])

  const handleModelSelect = useCallback((modelId: string) => {
    setModel(modelId)
    setModelSelectorOpen(false)
  }, [])

  const selectedModel = useMemo(() => {
    return models.find((item) => item.id === model)
  }, [model])

  const visibleMessages = messages.filter((message) => {
    return messageText(message, partsByMessage, textByPart).length > 0
  })
  const renderMessages: RenderMessage[] = visibleMessages.map((message) => {
    return {
      from: message.role,
      key: message.id,
      versions: [
        {
          content: messageText(message, partsByMessage, textByPart),
          id: message.id,
        },
      ],
    }
  })

  const isBusy = sessionStatus?.type === "busy"

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <Conversation>
        <ConversationContent className="mx-auto w-full lg:w-3/5 lg:px-4">
          {isPending ? (
            <div className="flex min-h-48 items-center justify-center">
              <Spinner aria-label="Loading session messages" />
            </div>
          ) : null}
          {!isPending
            ? renderMessages.map(({ versions, ...message }) => (
                <MessageBranch defaultBranch={0} key={message.key}>
                  <MessageBranchContent>
                    {versions.map((version) => (
                      <Message from={message.from} key={`${message.key}-${version.id}`}>
                        <MessageContent>
                          <MessageResponse>{version.content}</MessageResponse>
                        </MessageContent>
                      </Message>
                    ))}
                  </MessageBranchContent>
                  {versions.length > 1 ? (
                    <MessageBranchSelector>
                      <MessageBranchPrevious />
                      <MessageBranchPage />
                      <MessageBranchNext />
                    </MessageBranchSelector>
                  ) : null}
                </MessageBranch>
              ))
            : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 pt-4">
        <div className="mx-auto w-full px-4 pb-4 lg:w-3/5 lg:px-8">
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
