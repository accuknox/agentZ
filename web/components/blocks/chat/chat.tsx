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
  getAttachmentMediaCategory,
  inferAttachmentMediaType,
} from "@/components/ai-elements/attachments"
import {
  Message as AIMessage,
  MessageContent as AIMessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { AgentGettingReady, useAgentReadiness } from "@/components/agent-readiness"
import { AgentWorkingIndicator } from "@/components/agent-working-indicator"
import { Checkpoint, CheckpointIcon } from "@/components/ai-elements/checkpoint"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import type {
  PromptInputController,
  PromptInputFile,
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Message, MessageAvatar, MessageContent, MessageFooter } from "@/components/ui/message"
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
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
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
  type ChatAttachment,
  chatAttachmentConfig,
  chatAttachmentErrorMessage,
  promptFileFromPart,
} from "@/components/blocks/chat/attachments"
import type { ProviderModelItem } from "@/data/types"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { readAgentFileRawOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { formatByteSize, formatMessageTime } from "@/lib/format"
import { useObjectURL } from "@/hooks/use-object-url"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { Message as OpencodeMessage, Part, QuestionAnswer } from "@opencode-ai/sdk/v2"
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CpuIcon,
  DownloadIcon,
  GaugeIcon,
  PaperclipIcon,
  Settings2Icon,
  Undo2Icon,
} from "lucide-react"
import { motion } from "motion/react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useStickToBottomContext } from "use-stick-to-bottom"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
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
  promptMobile?: boolean
  sessionId?: string
}

type AuthSession = typeof authClient.$Infer.Session
type AuthUser = AuthSession["user"]

const DEFAULT_REASONING_LEVEL = "__default__"
const promptShiftTransition = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const

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

type SelectedPromptAttachment = Extract<PromptInputFile, { source: "local" }> & { id: string }

function PromptAttachmentDialog({
  attachment,
  onOpenChange,
}: {
  attachment: SelectedPromptAttachment | null
  onOpenChange: (open: boolean) => void
}) {
  if (!attachment) return null

  const url = attachment.url
  const category = getAttachmentMediaCategory(attachment)
  const isImage = category === "image"
  const isVideo = category === "video"
  const isAudio = category === "audio"
  const isPDF =
    inferAttachmentMediaType(attachment.filename, attachment.mediaType) === "application/pdf"
  const canPreview = isImage || isVideo || isAudio || isPDF

  const handleDownload = () => {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = attachment.filename
    anchor.click()
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(78dvh,48rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden overscroll-contain p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle className="truncate" translate="no">
            {attachment.filename}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preview or download {attachment.filename}
          </DialogDescription>
        </DialogHeader>
        <div className="bg-muted/20 flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob URL cannot use Next Image
            <img
              alt={attachment.filename}
              className="max-h-full max-w-full rounded-lg object-contain"
              height={1024}
              src={url}
              width={1024}
            />
          ) : null}
          {isVideo ? (
            <video
              aria-label={`Preview of ${attachment.filename}`}
              className="max-h-full max-w-full rounded-lg"
              controls
              src={url}
            />
          ) : null}
          {isAudio ? (
            <audio
              aria-label={`Preview of ${attachment.filename}`}
              className="w-full max-w-lg"
              controls
              src={url}
            />
          ) : null}
          {isPDF ? (
            <iframe
              className="size-full rounded-lg border bg-white"
              src={`${url}#toolbar=0`}
              title={`Preview of ${attachment.filename}`}
            />
          ) : null}
          {!canPreview ? (
            <div className="text-muted-foreground flex flex-col items-center gap-4 text-center">
              <p>
                Preview isn&apos;t available for{" "}
                <span className="break-all" translate="no">
                  {attachment.filename}
                </span>{" "}
                ({formatByteSize(attachment.size)}).
              </p>
              <Button onClick={handleDownload} variant="outline">
                <DownloadIcon aria-hidden="true" />
                Download
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PromptInputAttachmentsDisplay({ agentName }: { agentName: string }) {
  const attachments = usePromptInputAttachments()
  const { previewFile } = useFileWorkspace()
  const [selected, setSelected] = useState<SelectedPromptAttachment | null>(null)

  if (attachments.files.length === 0) {
    return null
  }

  return (
    <InputGroupAddon
      align="block-start"
      className="order-first flex-wrap px-3 pt-2 pb-1.5 empty:hidden"
    >
      <Attachments className="w-full flex-wrap gap-[6px]" variant="composer">
        {attachments.files.map((attachment) => (
          <Attachment
            data={attachment}
            key={attachment.id}
            onOpen={() => {
              if (attachment.source === "workspace") {
                previewFile(agentName, {
                  name: attachment.filename,
                  path: attachment.path,
                })
                return
              }
              setSelected(attachment)
            }}
            onRemove={() => attachments.remove(attachment.id)}
          >
            <AttachmentPreview />
            <AttachmentRemove label={`Remove ${attachment.filename}`} />
          </Attachment>
        ))}
      </Attachments>
      <PromptAttachmentDialog
        attachment={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      />
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
      <PaperclipIcon aria-hidden="true" />
    </PromptInputButton>
  )
}

function StoredAttachment({
  agentName,
  attachment,
  onOpen,
}: {
  agentName: string
  attachment: ChatAttachment
  onOpen: (path: string, name: string) => void
}) {
  const data = { ...attachment, type: "file" as const }
  const isImage = getAttachmentMediaCategory(data) === "image"
  const previewQuery = useQuery({
    ...readAgentFileRawOptions({
      parseAs: "blob",
      path: { agentName },
      query: { path: attachment.path },
    }),
    enabled: isImage,
    gcTime: 0,
  })
  const previewURL = useObjectURL(isImage ? previewQuery.data : undefined)

  return (
    <Attachment
      data={previewURL ? { ...data, url: previewURL } : data}
      onOpen={() => onOpen(attachment.path, attachment.filename)}
      title={`Preview ${attachment.filename}`}
    >
      <AttachmentPreview />
    </Attachment>
  )
}

function StoredAttachments({
  agentName,
  attachments,
  onOpen,
}: {
  agentName: string
  attachments: ChatAttachment[]
  onOpen: (path: string, name: string) => void
}) {
  return (
    <Attachments className="gap-[6px]" variant="composer">
      {attachments.map((attachment) => (
        <StoredAttachment
          agentName={agentName}
          attachment={attachment}
          key={attachment.id}
          onOpen={onOpen}
        />
      ))}
    </Attachments>
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

function ConversationOverflowFades() {
  const { contentRef, scrollRef } = useStickToBottomContext()
  const [overflow, setOverflow] = useState({ bottom: false, top: false })

  const updateOverflow = useCallback(() => {
    const element = scrollRef.current
    if (!element) return

    const top = element.scrollTop > 2
    const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 2
    setOverflow((current) => {
      if (current.bottom === bottom && current.top === top) return current
      return { bottom, top }
    })
  }, [scrollRef])

  useEffect(() => {
    const content = contentRef.current
    const element = scrollRef.current
    if (!element) return

    updateOverflow()
    element.addEventListener("scroll", updateOverflow, { passive: true })
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(element)
    if (content) observer.observe(content)

    return () => {
      element.removeEventListener("scroll", updateOverflow)
      observer.disconnect()
    }
  }, [contentRef, scrollRef, updateOverflow])

  return (
    <>
      {overflow.top ? (
        <div
          aria-hidden="true"
          className="from-background pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b to-transparent"
        />
      ) : null}
      {overflow.bottom ? (
        <div
          aria-hidden="true"
          className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t to-transparent"
        />
      ) : null}
    </>
  )
}

function SelectableTimeline({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<{ children: ReactNode }>()
  const rootRef = useRef<HTMLDivElement>(null)
  const pointerDownRef = useRef(false)

  useEffect(() => {
    const release = () => {
      if (pointerDownRef.current) return

      const selection = document.getSelection()
      const root = rootRef.current
      if (
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        root &&
        selection.getRangeAt(0).intersectsNode(root)
      ) {
        return
      }

      setSnapshot(undefined)
    }

    const finishPointer = () => {
      pointerDownRef.current = false
      release()
    }

    document.addEventListener("pointerup", finishPointer)
    document.addEventListener("pointercancel", finishPointer)
    document.addEventListener("selectionchange", release)
    window.addEventListener("blur", finishPointer)

    return () => {
      document.removeEventListener("pointerup", finishPointer)
      document.removeEventListener("pointercancel", finishPointer)
      document.removeEventListener("selectionchange", release)
      window.removeEventListener("blur", finishPointer)
    }
  }, [])

  return (
    <div
      className="mx-auto flex w-full flex-col gap-4 @xl/chat:w-4/5"
      onPointerDownCapture={(event) => {
        if (!event.isPrimary || event.button !== 0) return

        // Streaming markdown mutates selected text nodes. Keep this exact tree
        // mounted until the native selection leaves the timeline.
        pointerDownRef.current = true
        setSnapshot((current) => current ?? { children })
      }}
      ref={rootRef}
    >
      {snapshot ? snapshot.children : children}
    </div>
  )
}

function ChatInner({
  agentName,
  firstName,
  greetingIndex,
  promptMobile = false,
  sessionId,
}: ChatProps) {
  const [promotedSessionId, setPromotedSessionId] = useState<string>()
  const activeSessionId = sessionId ?? promotedSessionId
  const agentReadiness = useAgentReadiness(agentName)
  const composerRef = useRef<PromptInputController | null>(null)
  const { data: authSession } = authClient.useSession()

  const {
    applyOptimisticSession,
    blocked,
    loadError,
    isBusy,
    isPending,
    localMessages,
    messages,
    partsByMessage,
    permissionRequest,
    questionRequest,
    reconnectStream,
    reload,
    session,
    sessionCost,
    sessionStatus,
    streamError,
    textByPart,
    todos,
  } = useOpencodeChat(agentName, activeSessionId)

  useEffect(() => {
    const id = `chat:${agentName}:${activeSessionId ?? "new"}:history-error`
    if (!loadError) {
      toast.dismiss(id)
      return
    }

    toast.error("Failed to load chat", {
      action: { label: "Retry", onClick: reload },
      description: loadError,
      duration: Infinity,
      id,
    })
    return () => {
      toast.dismiss(id)
    }
  }, [activeSessionId, agentName, loadError, reload])

  useEffect(() => {
    const id = `chat:${agentName}:${activeSessionId ?? "new"}:stream-error`
    if (!streamError) {
      toast.dismiss(id)
      return
    }

    toast.error("Live session disconnected", {
      action: { label: "Reconnect", onClick: reconnectStream },
      description: streamError,
      duration: Infinity,
      id,
    })
    return () => {
      toast.dismiss(id)
    }
  }, [activeSessionId, agentName, reconnectStream, streamError])

  useEffect(() => {
    const id = `chat:${agentName}:${activeSessionId ?? "new"}:retry`
    if (sessionStatus?.type !== "retry") {
      toast.dismiss(id)
      return
    }

    const attempt = sessionStatus.attempt > 0 ? ` (attempt ${sessionStatus.attempt})` : ""
    toast.warning(`Retrying turn${attempt}`, {
      description: sessionStatus.message,
      duration: Infinity,
      id,
    })
    return () => {
      toast.dismiss(id)
    }
  }, [activeSessionId, agentName, sessionStatus])

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
  const { abortMessage, canSubmit, isStopping, sendMessage, sendState } = useOpencodeSend(
    agentName,
    activeSessionId,
    directory,
    isBusy || isPending || blocked || agentReadiness.isGettingReady,
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
      if (!activeSessionId || isStopping) return
      const client = await createAgentOpencodeClient(agentName)
      const result = messageID
        ? await client.session.revert({ directory, messageID, sessionID: activeSessionId })
        : await client.session.unrevert({ directory, sessionID: activeSessionId })
      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to update session"))
      }
      applyOptimisticSession(result.data)
    },
    [activeSessionId, agentName, applyOptimisticSession, directory, isStopping]
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
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
        .flatMap((part) => {
          const file = promptFileFromPart(part)
          return file ? [file] : []
        })
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
      if (message.text.trim().length === 0 && message.files.length === 0) {
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
        isBusy,
        isRetrying: sessionStatus?.type === "retry",
        localMessages,
        messages,
        partsByMessage,
        revertMessageID: session?.revert?.messageID,
        textByPart,
      }),
    [
      isBusy,
      localMessages,
      messages,
      partsByMessage,
      session?.revert?.messageID,
      sessionStatus?.type,
      textByPart,
    ]
  )
  const inputDisabled = blocked || isBusy || isStopping || agentReadiness.isGettingReady
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
        <ConversationContent className="w-full px-4">
          {showHistorySkeleton ? (
            <div className="mx-auto flex w-full flex-col gap-3 @xl/chat:w-4/5">
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-16 w-2/3 rounded-md" />
            </div>
          ) : !showStarter ? (
            <>
              <SelectableTimeline>
                {rows.map((row) => (
                  <TimelineRowView
                    agentName={agentName}
                    isBusy={isBusy}
                    isLastBlock={rows.at(-1)?.key === row.key}
                    key={row.key}
                    onRevert={handleRevert}
                    revertDisabled={isBusy || isStopping || revertPending}
                    row={row}
                    user={authSession?.user}
                  />
                ))}
                <AgentWorkingIndicator isWorking={isBusy} />
              </SelectableTimeline>
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
        <ConversationOverflowFades />
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
            showStarter ? "max-w-3xl gap-8" : "min-w-0 gap-4 px-4 pb-4 @xl/chat:w-4/5 @xl/chat:px-0"
          )}
        >
          {showStarter ? (
            <NewSessionGreeting firstName={firstName} greetingIndex={greetingIndex} />
          ) : null}
          <PromptInput
            controllerRef={composerRef}
            globalDrop
            maxFileSize={chatAttachmentConfig.maxFileSizeBytes}
            maxFiles={chatAttachmentConfig.maxFileCount}
            mobile={promptMobile}
            multiple
            onError={(code) => {
              toast.error(chatAttachmentErrorMessage(code))
            }}
            onSubmit={handleSubmit}
          >
            <PromptInputAttachmentsDisplay agentName={agentName} />
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
                    <div
                      className={cn(
                        "hidden min-w-0 items-center justify-end gap-1.5",
                        !promptMobile && "@xl/chat:flex"
                      )}
                    >
                      <ModelSelectorTrigger asChild>
                        <PromptInputButton
                          className="h-8 max-w-72 justify-start px-2"
                          disabled={inputDisabled}
                        >
                          {agentReadiness.isGettingReady ? (
                            <AgentGettingReady />
                          ) : (
                            <BrainIcon className="text-muted-foreground size-4" />
                          )}
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
                            <GaugeIcon className="text-muted-foreground size-4" />
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
                    <div
                      className={cn("justify-end", promptMobile ? "flex" : "flex @xl/chat:hidden")}
                    >
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
                              <BrainIcon />
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
                      <ModelSelectorInput placeholder="Search models…" />
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
                                  <BrainIcon />
                                  <ModelSelectorName>{item.name}</ModelSelectorName>
                                  <ModelSelectorLogoGroup>
                                    <CpuIcon key={item.providerID} />
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
                      isStopping ||
                      agentReadiness.isGettingReady ||
                      revertPending ||
                      (!isBusy && (!selectedModel || !canSubmit))
                    }
                    onStop={isBusy && !isStopping ? () => void abortMessage(directory) : undefined}
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

function UserMessageAvatar({ user }: { user?: AuthUser }) {
  const name = user?.name.trim() || "User"
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")

  return (
    <MessageAvatar>
      <Avatar>
        <AvatarImage alt={name} src={user?.image ?? undefined} />
        <AvatarFallback>{initials || "U"}</AvatarFallback>
      </Avatar>
    </MessageAvatar>
  )
}

function TimelineRowView({
  agentName,
  isBusy,
  isLastBlock,
  onRevert,
  revertDisabled,
  row,
  user,
}: {
  agentName: string
  isBusy: boolean
  isLastBlock: boolean
  onRevert: (messageID: string) => void
  revertDisabled: boolean
  row: TimelineRow
  user?: AuthUser
}) {
  const { previewFile } = useFileWorkspace()
  const openAgentFile = useCallback(
    (path: string, name: string) => {
      previewFile(agentName, { name, path })
    },
    [agentName, previewFile]
  )

  switch (row.type) {
    case "local": {
      return (
        <Message align="end" className="group is-user ml-auto max-w-[95%]" key={row.key}>
          <UserMessageAvatar user={user} />
          <MessageContent>
            <AIMessageContent
              className={cn(
                row.message.status === "failed"
                  ? "border-destructive/30 bg-destructive/10 text-destructive border"
                  : undefined,
                row.message.attachments.length > 0 ? "space-y-3" : undefined
              )}
            >
              {row.message.attachments.length > 0 ? (
                <StoredAttachments
                  agentName={agentName}
                  attachments={row.message.attachments}
                  onOpen={openAgentFile}
                />
              ) : null}
              {row.message.text.length > 0 ? (
                <MessageResponse>{row.message.text}</MessageResponse>
              ) : null}
            </AIMessageContent>
          </MessageContent>
        </Message>
      )
    }

    case "user": {
      const isEmpty = row.text.length === 0 && row.attachments.length === 0
      return (
        <Message align="end" className="group is-user ml-auto max-w-[95%]" key={row.key}>
          {isEmpty ? null : <UserMessageAvatar user={user} />}
          <MessageContent className={isEmpty ? "hidden" : undefined}>
            <AIMessageContent className={row.attachments.length > 0 ? "space-y-3" : undefined}>
              {row.attachments.length > 0 ? (
                <StoredAttachments
                  agentName={agentName}
                  attachments={row.attachments}
                  onOpen={openAgentFile}
                />
              ) : null}
              {row.text.length > 0 ? <MessageResponse>{row.text}</MessageResponse> : null}
            </AIMessageContent>
            <MessageFooter className="gap-1 px-0">
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
              <span>{formatMessageTime(row.createdAt)}</span>
            </MessageFooter>
          </MessageContent>
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
        <>
          <AIMessage from="assistant" key={row.key}>
            <AIMessageContent>
              {groups.map((group, groupIndex) => {
                switch (group.type) {
                  case "text":
                    return (
                      <MessageResponse key={group.key} onAgentFileOpen={openAgentFile}>
                        {group.content}
                      </MessageResponse>
                    )
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
            </AIMessageContent>
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
          </AIMessage>
        </>
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

    case "checkpoint": {
      return (
        <Checkpoint key={row.key}>
          <CheckpointIcon />
          <span className="shrink-0 text-xs">
            {row.variant === "compaction" ? "Context compacted" : "Interrupted"}
          </span>
        </Checkpoint>
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
