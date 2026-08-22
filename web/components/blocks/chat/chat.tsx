"use client"

import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { getImageProps } from "next/image"
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  getAttachmentMediaCategory,
  inferAttachmentMediaType,
} from "@/components/ai-elements/attachments"
import { MessageResponse } from "@/components/ai-elements/message"
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
import type { ChatSessionPreference } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { updateChatSessionPreference } from "@/lib/gateway/client"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { readAgentFileRawOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { formatByteSize } from "@/lib/format"
import { RelativeDateTime } from "@/components/relative-date-time"
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
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  BrainIcon,
  BotIcon,
  ArrowDownIcon,
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
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import { z } from "zod"
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
  agentNames: string[]
  chatPreferences?: ChatSessionPreference
  draftId?: string
  firstName?: string
  greetingIndex?: number
  promptMobile?: boolean
  sessionId?: string
  workspaceId: string
  workspacePath: string
  onAgentChange: (agentName: string) => void
  onSessionCreated: (sessionId: string) => void
}

type AuthUser = typeof authClient.$Infer.Session.user

const messageActorProfilesSchema = z
  .object({
    profiles: z.array(
      z
        .object({ id: z.string().min(1), image: z.string().nullable(), name: z.string().min(1) })
        .strict()
    ),
  })
  .strict()
type MessageActorProfile = z.infer<typeof messageActorProfilesSchema>["profiles"][number]

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
  workspaceId,
}: {
  agentName: string
  attachment: ChatAttachment
  onOpen: (path: string, name: string) => void
  workspaceId: string
}) {
  const data = { ...attachment, type: "file" as const }
  const isImage = getAttachmentMediaCategory(data) === "image"
  const previewQuery = useQuery({
    ...readAgentFileRawOptions({
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
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
  workspaceId,
}: {
  agentName: string
  attachments: ChatAttachment[]
  onOpen: (path: string, name: string) => void
  workspaceId: string
}) {
  return (
    <Attachments className="gap-[6px]" variant="composer">
      {attachments.map((attachment) => (
        <StoredAttachment
          agentName={agentName}
          attachment={attachment}
          key={attachment.id}
          onOpen={onOpen}
          workspaceId={workspaceId}
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

function ChatInner({
  agentName,
  agentNames,
  chatPreferences,
  draftId,
  firstName,
  greetingIndex,
  promptMobile = false,
  sessionId,
  workspaceId,
  workspacePath,
  onAgentChange,
  onSessionCreated,
}: ChatProps) {
  const queryClient = useQueryClient()
  const preferenceKey = ["chatSessionPreference", workspaceId] as const
  const agentReadiness = useAgentReadiness(agentName, workspaceId)
  const composerRef = useRef<PromptInputController | null>(null)
  const { data: authSession } = authClient.useSession()
  const rememberAgent = useMutation({
    mutationFn: async ({
      next,
    }: {
      next: ChatSessionPreference
      previous: ChatSessionPreference
    }) => {
      const result = await updateChatSessionPreference({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        body: next,
      })
      if (result.error) throw result.error
      return result.data
    },
    onError: (_, { next, previous }) => {
      if (queryClient.getQueryData(preferenceKey) !== next) return
      queryClient.setQueryData(preferenceKey, previous)
      toast.error("Could not remember the selected agent")
    },
    onSuccess: (saved, { next }) => {
      if (queryClient.getQueryData(preferenceKey) !== next) return
      queryClient.setQueryData(preferenceKey, saved)
    },
    scope: { id: `chat-preferences:${workspaceId}` },
  })
  const {
    applyOptimisticSession,
    blocked,
    hasEarlierMessages,
    isLoadingEarlier,
    loadError,
    isBusy,
    isPending,
    localMessages,
    loadEarlier,
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
  } = useOpencodeChat(agentName, workspaceId, sessionId, draftId)

  useEffect(() => {
    const id = `chat:${agentName}:${sessionId ?? "new"}:history-error`
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
  }, [agentName, loadError, reload, sessionId])

  useEffect(() => {
    const id = `chat:${agentName}:${sessionId ?? "new"}:stream-error`
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
  }, [agentName, reconnectStream, sessionId, streamError])

  useEffect(() => {
    const id = `chat:${agentName}:${sessionId ?? "new"}:retry`
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
  }, [agentName, sessionId, sessionStatus])

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
      queryKey: ["opencode", "modelCatalog", workspaceId, agentName],
      queryFn: async () => {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
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
    workspaceId,
    sessionId,
    draftId,
    directory,
    isBusy || isPending || blocked || agentReadiness.isGettingReady,
    onSessionCreated
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
      const client = await createAgentOpencodeClient(agentName, workspaceId)
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
      const client = await createAgentOpencodeClient(agentName, workspaceId)
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
      const client = await createAgentOpencodeClient(agentName, workspaceId)
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
      if (!sessionId || isStopping) return
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = messageID
        ? await client.session.revert({ directory, messageID, sessionID: sessionId })
        : await client.session.unrevert({ directory, sessionID: sessionId })
      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to update session"))
      }
      applyOptimisticSession(result.data)
    },
    [agentName, applyOptimisticSession, directory, isStopping, sessionId, workspaceId]
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
    [
      agentReadiness.isGettingReady,
      pushRecent,
      selectedModel,
      selectedReasoningVariant,
      sendMessage,
      sessionId,
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
  const actorUserIDs = useMemo(
    () =>
      [
        ...new Set(
          rows.flatMap((row) =>
            row.type === "user" && row.actor?.type === "user" ? [row.actor.id] : []
          )
        ),
      ].sort(),
    [rows]
  )
  const actorProfilesQuery = useQuery(
    queryOptions({
      enabled: actorUserIDs.length > 0,
      queryKey: ["message-actors", ...actorUserIDs],
      queryFn: async () => {
        const response = await fetch("/api/message-actors", {
          body: JSON.stringify({ userIds: actorUserIDs }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
        if (!response.ok) throw new Error("Failed to load message senders")
        return messageActorProfilesSchema.parse(await response.json())
      },
      staleTime: 60_000,
    })
  )
  const actorProfiles = useMemo(
    () => new Map(actorProfilesQuery.data?.profiles.map((profile) => [profile.id, profile]) ?? []),
    [actorProfilesQuery.data]
  )
  const timelineIdentity = useMemo(
    () => ({ actorProfiles, user: authSession?.user }),
    [actorProfiles, authSession?.user]
  )
  const inputDisabled = blocked || isBusy || isStopping || agentReadiness.isGettingReady
  const showStarter = !sessionId && !isPending && rows.length === 0
  const showHistorySkeleton = isPending && rows.length === 0 && !showStarter
  const timelineRef = useRef<LegendListRef>(null)
  const [timelineAtEnd, setTimelineAtEnd] = useState(true)

  return (
    <div className="absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden" data-agentz-chat>
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
      <div
        className={cn(
          "relative min-h-0 flex-1 transition-opacity duration-200",
          showStarter && "pointer-events-none opacity-0"
        )}
      >
        {showHistorySkeleton ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-4">
            <Skeleton className="h-16 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
            <Skeleton className="h-16 w-2/3 rounded-md" />
          </div>
        ) : !showStarter ? (
          <LegendList<TimelineRow>
            className="h-full min-h-0 overflow-x-hidden overscroll-y-contain px-4 [overflow-anchor:none]"
            recycleItems={false}
            data={rows}
            estimatedItemSize={96}
            extraData={timelineIdentity}
            initialScrollAtEnd
            keyExtractor={(row) => row.key}
            ListHeaderComponent={
              hasEarlierMessages ? (
                <div className="text-muted-foreground/70 flex h-9 items-center justify-center gap-2 text-xs">
                  {isLoadingEarlier ? (
                    <>
                      <Spinner />
                      Loading earlier turns…
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="h-4" />
              )
            }
            ListFooterComponent={
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-56">
                <AgentWorkingIndicator isWorking={isBusy} />
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
                    onReject={() => void rejectQuestion()}
                    onSubmit={(answers) => void submitQuestionAnswer(answers)}
                    pending={isQuestionPending || isQuestionRejectPending}
                    request={questionRequest}
                  />
                ) : null}
              </div>
            }
            maintainScrollAtEnd={
              timelineAtEnd
                ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
                : false
            }
            maintainVisibleContentPosition={{ data: true, size: true }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
              setTimelineAtEnd(
                contentOffset.y + layoutMeasurement.height >= contentSize.height - 24
              )
            }}
            onStartReached={() => {
              if (hasEarlierMessages && !isLoadingEarlier) void loadEarlier()
            }}
            onStartReachedThreshold={0.35}
            ref={timelineRef}
            renderItem={({ item }) => (
              <div
                className={cn(
                  item.type === "assistant" && isBusy && rows.at(-1)?.key === item.key
                    ? "pb-2"
                    : item.type === "thinking" || item.type === "checkpoint"
                      ? "pb-1.5"
                      : "pb-4",
                  item.type === "assistant-error"
                    ? "-mx-4 w-[calc(100%+2rem)] max-w-none"
                    : "mx-auto w-full max-w-3xl"
                )}
              >
                <TimelineRowView
                  agentName={agentName}
                  actorProfiles={timelineIdentity.actorProfiles}
                  isBusy={isBusy}
                  isLastBlock={rows.at(-1)?.key === item.key}
                  onRevert={handleRevert}
                  revertDisabled={isBusy || isStopping || revertPending}
                  row={item}
                  user={timelineIdentity.user}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                />
              </div>
            )}
          />
        ) : null}
        {!timelineAtEnd && !showStarter ? (
          <Button
            aria-label="Scroll to latest message"
            className="bg-background/80 absolute bottom-[14.5rem] left-1/2 z-20 -translate-x-1/2 rounded-full shadow-sm backdrop-blur-md"
            onClick={() => timelineRef.current?.scrollToEnd({ animated: true })}
            size="icon"
            variant="outline"
          >
            <ArrowDownIcon />
          </Button>
        ) : null}
        {!showStarter ? <QuickTurnNav listRef={timelineRef} rows={rows} /> : null}
      </div>
      <motion.div
        className={cn(
          "pointer-events-none absolute inset-x-0 z-30 grid gap-4 px-3 sm:px-5",
          showStarter ? "top-1/2 -translate-y-1/2" : "bottom-0 pb-4"
        )}
        layout
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
      >
        <div
          className={cn(
            "pointer-events-auto mx-auto flex w-full max-w-3xl flex-col",
            showStarter ? "gap-8" : "min-w-0"
          )}
        >
          {showStarter ? (
            <NewSessionGreeting firstName={firstName} greetingIndex={greetingIndex} />
          ) : null}
          <div className="chat-composer-glass-shell relative w-full pb-9">
            <PromptInput
              className="agentz-chat-composer chat-composer-glass-host relative z-10 rounded-[22px]"
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
              <PromptInputBody className="grid min-h-[10.25rem] grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(5.5rem,auto)_auto] items-end gap-x-2 gap-y-2 px-3 pt-3.5 pb-3 sm:px-4 sm:pt-4 sm:pb-4">
                <motion.div
                  className="col-start-1 row-start-2"
                  layout="position"
                  transition={promptShiftTransition}
                >
                  <PromptInputAttachmentButton disabled={inputDisabled} />
                </motion.div>
                <PromptInputTextarea
                  className="placeholder:text-muted-foreground/80 col-span-full col-start-1 row-start-1 max-h-48 min-h-[5.5rem] self-stretch px-1 py-0 text-[15px] leading-6"
                  disabled={inputDisabled}
                />
                <div className="contents">
                  <motion.div
                    className="col-start-2 row-start-2 min-w-0"
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
                              <SelectValue placeholder="Reasoning" />
                            </ReasoningSelectTrigger>
                            <SelectContent align="end" position="popper" side="top" sideOffset={8}>
                              <SelectGroup>
                                <SelectItem value={DEFAULT_REASONING_LEVEL}>
                                  <GaugeIcon />
                                  Default
                                </SelectItem>
                                {reasoningVariants.map((variant) => (
                                  <SelectItem key={variant} value={variant}>
                                    <GaugeIcon />
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
                        className={cn(
                          "justify-end",
                          promptMobile ? "flex" : "flex @xl/chat:hidden"
                        )}
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
                                      <GaugeIcon />
                                      Default
                                    </DropdownMenuRadioItem>
                                    {reasoningVariants.map((variant) => (
                                      <DropdownMenuRadioItem
                                        className="capitalize"
                                        disabled={inputDisabled}
                                        key={variant}
                                        value={variant}
                                      >
                                        <GaugeIcon />
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
                    className="col-start-3 row-start-2"
                    layout="position"
                    transition={promptShiftTransition}
                  >
                    <PromptInputSubmit
                      className="size-9 shadow-xs transition-all duration-150 hover:scale-105 active:shadow-none enabled:inset-shadow-[0_1px_rgb(255_255_255_/_0.16)] disabled:hover:scale-100"
                      disabled={
                        blocked ||
                        isStopping ||
                        agentReadiness.isGettingReady ||
                        revertPending ||
                        sendState === "submitted" ||
                        (!isBusy && (!selectedModel || !canSubmit))
                      }
                      onStop={
                        isBusy && !sendState && !isStopping
                          ? () => void abortMessage(directory)
                          : undefined
                      }
                      status={sendState ?? (isBusy ? "streaming" : undefined)}
                    />
                  </motion.div>
                </div>
              </PromptInputBody>
            </PromptInput>
            <div className="chat-composer-context-strip absolute inset-x-[1.375rem] bottom-0 z-0 flex h-10 items-end px-3 pb-1">
              <Select
                disabled={sessionId !== undefined || agentNames.length < 2}
                onValueChange={(name) => {
                  onAgentChange(name)
                  const previous =
                    queryClient.getQueryData<ChatSessionPreference>(preferenceKey) ??
                    chatPreferences
                  if (!previous) return
                  const next = { ...previous, last_agent_name: name }
                  queryClient.setQueryData(preferenceKey, next)
                  rememberAgent.mutate({ next, previous })
                }}
                value={agentName}
              >
                <ReasoningSelectTrigger
                  aria-label={sessionId ? "Agent locked for this chat" : "Choose agent"}
                  className="hover:bg-foreground/5 h-7 max-w-64 min-w-0 border-0 bg-transparent px-1.5 text-xs shadow-none"
                  size="sm"
                >
                  <SelectValue />
                </ReasoningSelectTrigger>
                <SelectContent align="start" position="popper" side="top" sideOffset={6}>
                  <SelectGroup>
                    {agentNames.map((name) => (
                      <SelectItem key={name} value={name}>
                        <BotIcon />
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function QuickTurnNav({
  listRef,
  rows,
}: {
  listRef: RefObject<LegendListRef | null>
  rows: TimelineRow[]
}) {
  const [active, setActive] = useState<number>()
  const [viewportWidth, setViewportWidth] = useState(0)
  const navRef = useRef<HTMLElement>(null)
  const turns = useMemo(() => {
    const items: {
      assistantText: string | undefined
      key: string
      rowIndex: number
      text: string
    }[] = []

    for (const [rowIndex, row] of rows.entries()) {
      if (row.type === "user") {
        items.push({ assistantText: undefined, key: row.key, rowIndex, text: row.text })
        continue
      }
      if (row.type !== "assistant") continue

      const text = row.entries.find((entry) => entry.type === "text")?.content
      const item = items.at(-1)
      if (item && text !== undefined) item.assistantText = text
    }

    return items
  }, [rows])
  const hasTurns = turns.length >= 2

  useEffect(() => {
    const viewport = navRef.current?.parentElement
    if (!viewport) return

    setViewportWidth(viewport.clientWidth)
    const observer = new ResizeObserver(() => setViewportWidth(viewport.clientWidth))
    observer.observe(viewport)

    return () => observer.disconnect()
  }, [hasTurns])

  if (!hasTurns) return null

  const gutter = Math.max(0, (viewportWidth - Math.min(viewportWidth, 768)) / 2)
  const hitWidth = Math.max(0, Math.min(40, Math.floor(gutter) - 12))
  const turnIndexAt = (clientY: number, rail: HTMLElement) => {
    const rect = rail.getBoundingClientRect()
    const progress = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    return Math.round(progress * (turns.length - 1))
  }
  const selected = active === undefined ? undefined : turns[active]
  const previewWords = selected?.assistantText?.match(/\S+/g)
  const selectedTop = active === undefined ? 0 : (active / (turns.length - 1)) * 100
  const previewOffset = active === 0 ? "0%" : active === turns.length - 1 ? "-100%" : "-50%"

  return (
    <nav
      aria-label="Chat turns"
      className={cn(
        "pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        gutter >= 48
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100"
      )}
      ref={navRef}
    >
      <button
        aria-label={`Jump to message: ${selected?.text || "Attachment"}`}
        className={cn(
          "focus-visible:ring-ring/70 absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:ring-2 focus-visible:outline-none",
          hitWidth > 0 ? "pointer-events-auto" : "pointer-events-none"
        )}
        onBlur={() => setActive(undefined)}
        onClick={(event) => {
          const turn = turns[turnIndexAt(event.clientY, event.currentTarget)]
          if (!turn) return

          void listRef.current?.scrollToIndex({
            animated: true,
            index: turn.rowIndex,
            viewOffset: 24,
          })
          event.currentTarget.blur()
        }}
        onFocus={() => setActive((current) => current ?? 0)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setActive((current) => Math.min((current ?? 0) + 1, turns.length - 1))
            return
          }
          if (event.key === "ArrowUp") {
            event.preventDefault()
            setActive((current) => Math.max((current ?? 0) - 1, 0))
            return
          }
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault()
            setActive(event.key === "Home" ? 0 : turns.length - 1)
            return
          }
          if ((event.key === "Enter" || event.key === " ") && selected) {
            event.preventDefault()
            void listRef.current?.scrollToIndex({
              animated: true,
              index: selected.rowIndex,
              viewOffset: 24,
            })
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        onMouseLeave={() => setActive(undefined)}
        onMouseMove={(event) => setActive(turnIndexAt(event.clientY, event.currentTarget))}
        style={{
          height: `min(${Math.max(1, (turns.length - 1) * 8)}px, calc(100vh - 18rem))`,
          width: selected ? "22rem" : hitWidth,
        }}
        type="button"
      >
        <div className="bg-border/15 absolute top-0 left-3 h-full w-px" />
        {turns.map((turn, index) => (
          <span
            aria-hidden="true"
            className={cn(
              "bg-muted-foreground/35 absolute left-0 h-0.5 -translate-y-1/2 rounded-full transition-[background-color,width] duration-150",
              active === index
                ? "bg-muted-foreground/75 w-6"
                : active !== undefined && Math.abs(active - index) === 1
                  ? "w-4"
                  : active !== undefined && Math.abs(active - index) === 2
                    ? "w-2.5"
                    : "w-2"
            )}
            key={turn.key}
            style={{ top: `${(index / (turns.length - 1)) * 100}%` }}
          />
        ))}
        {selected ? (
          <span
            className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseMove={(event) => event.stopPropagation()}
            style={{ top: `${selectedTop}%`, transform: `translateY(${previewOffset})` }}
          >
            <span className="bg-popover/90 text-popover-foreground ring-foreground/10 block rounded-xl p-3 text-left shadow-xl ring-1 backdrop-blur-xl">
              <span className="block truncate text-sm leading-5 font-medium">
                {selected.text || "Attachment"}
              </span>
              {previewWords?.length ? (
                <span className="text-muted-foreground mt-1 block text-sm leading-5">
                  {previewWords.slice(0, 30).join(" ")}
                  {previewWords.length > 30 ? "..." : null}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
      </button>
    </nav>
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

function UserMessageAvatar({
  image,
  name,
  label,
}: {
  image?: string | null
  name: string
  label: string
}) {
  const displayName = name.trim() || "User"
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  const avatarImage = image
    ? getImageProps({ alt: displayName, height: 32, src: image, width: 32 }).props
    : undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={label} className="shrink-0">
          <Avatar>
            {avatarImage ? <AvatarImage {...avatarImage} /> : null}
            <AvatarFallback>{initials || "U"}</AvatarFallback>
          </Avatar>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TimelineRowView({
  agentName,
  actorProfiles,
  isBusy,
  isLastBlock,
  onRevert,
  revertDisabled,
  row,
  user,
  workspaceId,
  workspacePath,
}: {
  agentName: string
  actorProfiles: Map<string, MessageActorProfile>
  isBusy: boolean
  isLastBlock: boolean
  onRevert: (messageID: string) => void
  revertDisabled: boolean
  row: TimelineRow
  user?: AuthUser
  workspaceId: string
  workspacePath: string
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
        <div className="group flex items-end justify-end gap-2">
          <div
            className={cn(
              "bg-message text-message-foreground relative max-w-[80%] rounded-2xl p-3 text-sm",
              row.message.status === "failed" &&
                "border-destructive/30 bg-destructive/10 text-destructive border"
            )}
          >
            {row.message.attachments.length > 0 ? (
              <StoredAttachments
                agentName={agentName}
                attachments={row.message.attachments}
                onOpen={openAgentFile}
                workspaceId={workspaceId}
              />
            ) : null}
            {row.message.text.length > 0 ? (
              <MessageResponse>{row.message.text}</MessageResponse>
            ) : null}
          </div>
          <UserMessageAvatar
            image={user?.image}
            label={user?.name ?? "You"}
            name={user?.name ?? "You"}
          />
        </div>
      )
    }

    case "user": {
      const isEmpty = row.text.length === 0 && row.attachments.length === 0
      if (isEmpty) return null
      const profile = row.actor?.type === "user" ? actorProfiles.get(row.actor.id) : undefined
      const name = profile?.name ?? row.actor?.name
      const label = row.actor
        ? `${name} · ${
            row.actor.type === "user" ? "User" : row.actor.type === "api_key" ? "API key" : "System"
          }`
        : undefined

      return (
        <div className="group flex flex-col items-end gap-1">
          <div className="flex w-full items-end justify-end gap-2">
            <div className="bg-message text-message-foreground relative max-w-[80%] rounded-2xl p-3 text-sm">
              {row.attachments.length > 0 ? (
                <StoredAttachments
                  agentName={agentName}
                  attachments={row.attachments}
                  onOpen={openAgentFile}
                  workspaceId={workspaceId}
                />
              ) : null}
              {row.text.length > 0 ? <MessageResponse>{row.text}</MessageResponse> : null}
            </div>
            {name && label ? (
              <UserMessageAvatar image={profile?.image} label={label} name={name} />
            ) : null}
          </div>
          <div className="flex w-full max-w-[80%] items-center justify-end gap-2 pe-11 text-xs tabular-nums opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
            <RelativeDateTime value={row.createdAt} />
            <div className="flex items-center gap-0.5">
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
            </div>
          </div>
        </div>
      )
    }

    case "assistant": {
      const groups = groupEntries(row.entries)
      const lastGroupIndex = groups.length - 1
      const showMeta = !(isBusy && isLastBlock)
      const copyText = row.entries
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.content)
        .join("\n\n")
      return (
        <div className="group flex w-full min-w-0 flex-col">
          <div className="relative min-w-0 px-1 py-0.5 text-sm">
            {groups.map((group, groupIndex) => {
              const spacing = groupIndex === lastGroupIndex ? undefined : "pb-2"

              switch (group.type) {
                case "text":
                  return (
                    <div className={spacing} key={group.key}>
                      <MessageResponse onAgentFileOpen={openAgentFile}>
                        {group.content}
                      </MessageResponse>
                    </div>
                  )
                case "reasoning": {
                  const isStreaming = isBusy && isLastBlock && groupIndex === lastGroupIndex
                  return (
                    <div className={spacing} key={group.key}>
                      <Reasoning isStreaming={isStreaming}>
                        <ReasoningTrigger />
                        <ReasoningContent>{group.content}</ReasoningContent>
                      </Reasoning>
                    </div>
                  )
                }
                case "tool-group":
                  return (
                    <div className={spacing} key={group.key}>
                      <div className="border-border/60 ml-1 max-w-full min-w-0 space-y-px overflow-hidden border-l py-0.5 pl-3">
                        {group.entries.map((entry) => {
                          const toolEntry = entry.toolEntries[0]
                          if (!toolEntry) return null
                          return (
                            <ToolEntries
                              agentName={agentName}
                              entry={toolEntry}
                              key={entry.key}
                              workspacePath={workspacePath}
                            />
                          )
                        })}
                      </div>
                    </div>
                  )
                default:
                  return null
              }
            })}
          </div>
          {showMeta ? (
            <div className="mt-1.5 flex items-center gap-1 px-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
              <RelativeDateTime className="text-xs" value={row.createdAt} />
              {copyText.length > 0 ? (
                <MessageActionBar>
                  <CopyButton content={copyText} />
                </MessageActionBar>
              ) : null}
            </div>
          ) : null}
        </div>
      )
    }

    case "thinking": {
      return (
        <div className="text-muted-foreground text-sm">
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
        <Accordion className="w-full" type="multiple">
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
        <Checkpoint>
          <CheckpointIcon />
          <span className="shrink-0 text-xs">
            {row.variant === "compaction" ? "Context compacted" : "Interrupted"}
          </span>
        </Checkpoint>
      )
    }

    case "assistant-error": {
      return (
        <Alert variant="destructive">
          <AlertTitle>{row.label}</AlertTitle>
          <AlertDescription>{row.body}</AlertDescription>
        </Alert>
      )
    }
  }
}

export default function Chat(props: ChatProps) {
  return <ChatInner {...props} />
}
