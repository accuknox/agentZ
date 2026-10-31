"use client"

import styles from "./composer.module.css"
import { WorkGroup } from "./activity"
import { ChatActivityContext } from "./display"
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
import { ChatMessage, MessageResponse } from "@/components/ai-elements/message"
import { AgentGettingReady, useAgentReadiness } from "@/components/agent-readiness"
import { Separator } from "@/components/ui/separator"
import { AgentPresence } from "@/components/interior/agent-presence"
import { ProviderIcons } from "@/app/(app)/inference/providers/provider-shared"
import { Shimmer } from "@/components/ai-elements/shimmer"
import type {
  PromptInputController,
  PromptInputFile,
  PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useChatModelStorage } from "@/components/blocks/chat/use-chat-model-storage"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { NewSessionGreeting } from "@/components/blocks/chat/new-session-greeting"
import {
  sessionInfoQueryOptions,
  useOpencodeChat,
} from "@/components/blocks/chat/use-opencode-chat"
import { ChatQueue } from "./queue"
import { useOpencodeSend, type CreateSession } from "@/components/blocks/chat/use-opencode-send"
import {
  type PermissionDecision,
  PermissionDock,
  PlanDock,
  QuestionDock,
  RevertDock,
  TodoDock,
} from "@/components/blocks/chat/docks"
import { NewItemsPill } from "@/components/interior/new-items-pill"
import { CopyButton } from "@/components/interior/copy-button"
import { projectTimeline, type TimelineRow } from "@/components/blocks/chat/timeline"
import { describeMessageError, opencodeErrorMessage } from "@/components/blocks/chat/errors"
import {
  type ChatAttachment,
  chatAttachmentConfig,
  chatAttachmentErrorMessage,
  promptFileFromPart,
} from "@/components/blocks/chat/attachments"
import type { ProviderModelItem } from "@/data/types"
import type { ChatInput, ChatSessionPreference, CodingTextRequest } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { updateChatSessionPreference } from "@/lib/gateway/client"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import {
  listAgentModelCatalogOptions,
  readAgentFileRawOptions,
} from "@/lib/gateway/client/@tanstack/react-query.gen"
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
  DialogTrigger,
} from "@/components/ui/dialog"
import type { Message as OpencodeMessage, Part, QuestionAnswer, Session } from "@opencode-ai/sdk/v2"
import {
  queryOptions,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import {
  ArrowUpIcon,
  SquareIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  GaugeIcon,
  HammerIcon,
  PencilRulerIcon,
  PaperclipIcon,
  Settings2Icon,
  Undo2Icon,
  CircleAlert,
  BookmarkIcon,
} from "lucide-react"
import {
  type ReactNode,
  type RefObject,
  type ComponentProps,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import { useReducedMotion } from "motion/react"
import { z } from "zod"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Context } from "@/components/ai-elements/context"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger as ReasoningSelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { LanguageModelUsage } from "ai"

type ChatScroll = {
  offset: number
  atEnd: boolean
  estimatedItemSize?: number
  anchor?: { key: string; viewOffset: number }
}

type ChatDraft = PromptInputMessage & { restore?: true }

function ChatPromptInput({
  draftKey,
  initialMessage,
  onMessageChange,
  controllerRef,
  ...props
}: Omit<ComponentProps<typeof PromptInput>, "onSubmitError"> & { draftKey: QueryKey }) {
  const queryClient = useQueryClient()
  const recovery = useQuery(
    queryOptions({
      queryKey: draftKey,
      queryFn: skipToken,
      initialData: initialMessage ?? { text: "", files: [] },
      // Keystrokes persist without rendering the chat. Only failed submissions
      // notify this composer, including one mounted after the request started.
      select: (draft: ChatDraft) => (draft.restore ? draft : undefined),
    })
  )
  useLayoutEffect(() => {
    if (recovery.data) controllerRef?.current?.setMessage(recovery.data)
  }, [controllerRef, recovery.data])
  return (
    <PromptInput
      {...props}
      controllerRef={controllerRef}
      initialMessage={queryClient.getQueryData<ChatDraft>(draftKey)}
      onMessageChange={(message) => {
        queryClient.setQueryData(draftKey, message)
        onMessageChange?.(message)
      }}
      onSubmitError={(message) => {
        queryClient.setQueryData<ChatDraft>(draftKey, (current) => {
          // Logout and deletion remove the draft; a late failure must not
          // recreate private state after either boundary.
          if (!current) return
          const untouched = !current.text && !current.files.length
          return {
            requestID: untouched ? message.requestID : current.requestID,
            text: [message.text, current.text].filter(Boolean).join("\n\n"),
            files: [...message.files, ...current.files],
            restore: true,
          }
        })
      }}
    />
  )
}

type PendingTimelineRow = {
  author?: typeof authClient.$Infer.Session.user | ChatInput["author"]
  files: PromptInputMessage["files"] | ChatInput["content"]["attachments"]
  key: string
  progress?: string
  text: PromptInputMessage["text"]
  type: "pending"
}

export type ChatProps = {
  coding?: boolean
  draftId?: string
  draftMode?: Session["agent"]
  onDraftModeChange?: (mode: string) => void
  draftModel?: CodingTextRequest["model"]
  onDraftModelChange?: (model: NonNullable<CodingTextRequest["model"]>) => void
  revertDisabled?: boolean
  createSession?: CreateSession
  composerContext?: (disabled: boolean) => ReactNode
  agentName: string
  agentNames: string[]
  chatPreferences?: ChatSessionPreference
  initialMessage?: PromptInputMessage
  onDraftChange?: (message: PromptInputMessage) => void
  projectName?: string
  firstName?: string
  greetingIndex?: number
  promptMobile?: boolean
  navigationPending?: boolean
  sessionId?: string
  workspaceId: string
  onAgentChange: (agentName: string) => void
  onSessionCreated: (sessionId: string) => void
}

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

type AssistantUsage = {
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
    if (message?.role !== "assistant") continue

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
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-5">
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
            <div className="flex flex-col items-center gap-4 text-center text-muted-foreground">
              <p>
                Preview is not available for{" "}
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

function WorkingShimmer({ text }: { text?: string }) {
  // Streaming updates must not reshuffle the fallback while it is visible.
  const [fallback] = useState(() => {
    switch (Math.floor(Math.random() * 5)) {
      case 0:
        return "Turning the tiny gears"
      case 1:
        return "Following a little spark"
      case 2:
        return "Untangling a curious little knot"
      case 3:
        return "Fitting the pieces into place"
      default:
        return "Giving the idea a little wiggle"
    }
  })

  return <Shimmer className="min-w-0 truncate text-sm">{text ?? fallback}</Shimmer>
}

export default function Chat({
  revertDisabled = false,
  createSession,
  composerContext,
  agentName,
  agentNames,
  chatPreferences,
  initialMessage,
  draftId,
  draftModel,
  coding = false,
  draftMode,
  onDraftModeChange,
  onDraftModelChange,
  onDraftChange,
  projectName,
  firstName,
  greetingIndex,
  promptMobile = false,
  navigationPending = false,
  sessionId,
  workspaceId,
  onAgentChange,
  onSessionCreated,
}: ChatProps) {
  const queryClient = useQueryClient()
  const showWork = useContext(ChatActivityContext)
  const reducedMotion = useReducedMotion()
  const agentReadiness = useAgentReadiness(agentName, workspaceId)
  const composerRef = useRef<PromptInputController | null>(null)
  const { data: authSession } = authClient.useSession()
  const timelineRef = useRef<LegendListRef>(null)
  const timelineLoaded = useRef(false)
  const scrollQuery = useMemo(
    () =>
      queryOptions({
        queryKey: ["chatScroll", workspaceId, agentName, authSession?.user.id, sessionId],
      }),
    [workspaceId, agentName, authSession?.user.id, sessionId]
  )
  const [initialScroll] = useState(() => queryClient.getQueryData<ChatScroll>(scrollQuery.queryKey))
  const scroll = useRef(initialScroll)
  const timelineHeaderHeight = useRef(0)
  const following = useRef(initialScroll?.atEnd ?? true)
  const physicalEnd = useRef(initialScroll?.atEnd ?? true)
  const [timelineFollowing, setTimelineFollowing] = useState(initialScroll?.atEnd ?? true)
  const [timelineAtEnd, setTimelineAtEnd] = useState(initialScroll?.atEnd ?? true)
  const scrollFrame = useRef<number | undefined>(undefined)
  const releaseFollow = () => {
    following.current = false
    setTimelineFollowing(false)
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    const node = timelineRef.current?.getScrollableNode()
    // Cancel a smooth follow before native wheel/key navigation takes over.
    if (node) node.scrollTo({ top: node.scrollTop, behavior: "instant" })
  }
  const draftKey = [
    "chatDraft",
    workspaceId,
    agentName,
    authSession?.user.id,
    sessionId ?? draftId ?? "new",
  ]
  const draftMessage = queryClient.getQueryData<ChatDraft>(draftKey) ?? initialMessage
  const preferenceKey = ["chatSessionPreference", workspaceId, authSession?.user.id] as const
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
    updateSession,
    blocked,
    hasEarlierMessages,
    isLoadingEarlier,
    isRefreshingHistory,
    loadError,
    isBusy,
    isPending,
    loadEarlier,
    messages,
    partsByMessage,
    permissionRequest,
    questionRequest,
    reconnectStream,
    reload,
    session,
    sessionUnavailable,
    sessionStatus,
    streamError,
    textByPart,
    todos,
  } = useOpencodeChat(agentName, workspaceId, sessionId, authSession?.user.id)

  const questionTool = questionRequest?.tool
  const planApproval =
    coding &&
    questionRequest?.sessionID === session?.id &&
    questionTool &&
    partsByMessage[questionTool.messageID]?.some(
      (part) =>
        part.type === "tool" && part.callID === questionTool.callID && part.tool === "plan_exit"
    )

  // Approval creates a synthetic Build user message without updating
  // session.agent. Raw user history owns the mode, including after reconnect.
  const lastUser = messages.findLast(
    (message) =>
      message.role === "user" && (!session?.revert || message.id < session.revert.messageID)
  )
  // A revert can precede the loaded page. Fetch its preceding user turn
  // before choosing a mode rather than falling back to stale session metadata.
  const modeHistoryPending =
    coding && session?.revert !== undefined && !lastUser && hasEarlierMessages
  useEffect(() => {
    if (modeHistoryPending && !isLoadingEarlier && !loadError) void loadEarlier()
  }, [modeHistoryPending, isLoadingEarlier, loadError, loadEarlier])
  const [modeSelection, setModeSelection] = useState<{
    mode: string
    messageID?: string
    revertID?: string
  }>()
  const modeSelectionCurrent =
    modeSelection?.messageID === lastUser?.id &&
    modeSelection?.revertID === session?.revert?.messageID
  if (modeSelection && !modeSelectionCurrent) setModeSelection(undefined)
  const mode =
    (modeSelectionCurrent ? modeSelection?.mode : undefined) ??
    lastUser?.agent ??
    (session?.revert ? undefined : session?.agent) ??
    (!sessionId ? draftMode : undefined) ??
    "build"

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
  const [model, setModel] = useState(
    draftModel ? `${draftModel.providerID}:${draftModel.modelID}` : ""
  )
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
  const branding = useQuery({
    ...listAgentModelCatalogOptions({
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
      path: { agentName },
    }),
    staleTime: 60_000,
  })
  const modelBrands = useMemo(
    () =>
      new Map(
        branding.data?.map((entry) => [`${entry.provider_id}:${entry.model_id}`, entry.providers])
      ),
    [branding.data]
  )

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
          agents: agentsResult.data,
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
  const catalogAgent = catalog?.agents.find((item) => item.name === agentName)
  const modes = catalog?.agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
  const modeAvailable = modes?.some((agent) => agent.name === mode)
  const nextMode = mode === "plan" ? "build" : "plan"

  const models = useMemo(() => catalog?.models ?? [], [catalog?.models])
  const chefs = useMemo(() => catalog?.chefs ?? [], [catalog?.chefs])
  const sessionModel = session?.model
  const agentModel = catalogAgent?.model
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
      catalogAgent?.variant &&
      variants.has(catalogAgent.variant)
    ) {
      fallbackReasoningLevel = catalogAgent.variant
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
  // context usage indicator.
  const revertMessageID = session?.revert?.messageID
  const contextMessages = revertMessageID
    ? messages.filter((message) => message.id < revertMessageID)
    : messages
  const contextUsage = getAssistantUsage(contextMessages, models)
  const {
    abortMessage,
    canStop,
    canSubmit,
    hasSession,
    isStopping,
    sendMessage,
    sendState,
    pending: pendingMessages,
    queue,
    queueError,
    updateInput,
  } = useOpencodeSend(
    agentName,
    workspaceId,
    sessionId,
    (id) => {
      // Carry unsent input into the session draft scope on promotion.
      const nextDraftKey = [...draftKey.slice(0, -1), id]
      queryClient.setQueryData(nextDraftKey, composerRef.current?.getMessage())
      onSessionCreated?.(id)
    },
    createSession
  )

  useEffect(() => {
    if (models.length === 0 || !modelStorageReady) return
    clearInvalid((storedModel) => {
      return models.some((item) => {
        return item.providerID === storedModel.providerID && item.modelID === storedModel.modelID
      })
    })
  }, [clearInvalid, modelStorageReady, models])

  const {
    isPending: isQuestionPending,
    mutate: submitQuestionAnswer,
    mutateAsync: answerQuestion,
  } = useMutation({
    mutationFn: async (answers: QuestionAnswer[]) => {
      if (!questionRequest) {
        throw new Error("No question request is active")
      }
      if (!directory) throw new Error("Wait for the session to finish loading")
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.question.reply({
        directory,
        answers,
        requestID: questionRequest.id,
      })
      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to answer question"))
      }
    },
    onError: (error) => {
      toast.error("Couldn't submit answers", {
        description: error.message,
      })
    },
  })

  const { isPending: isQuestionRejectPending, mutateAsync: rejectQuestion } = useMutation({
    mutationFn: async () => {
      if (!questionRequest) {
        throw new Error("No question request is active")
      }
      if (!directory) throw new Error("Wait for the session to finish loading")
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.question.reject({
        directory,
        requestID: questionRequest.id,
      })
      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to reject question"))
      }
    },
    onError: (error) => {
      toast.error("Couldn't dismiss question", {
        description: error.message,
      })
    },
  })

  const { isPending: isPermissionPending, mutateAsync: replyPermission } = useMutation({
    mutationFn: async (reply: PermissionDecision) => {
      if (!permissionRequest) {
        throw new Error("No permission request is active")
      }
      if (!directory) throw new Error("Wait for the session to finish loading")
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.permission.reply({
        directory,
        requestID: permissionRequest.id,
        reply,
      })
      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to respond to permission"))
      }
    },
    onError: (error) => {
      toast.error("Couldn't reply to permission", {
        description: error.message,
      })
    },
  })

  // Publish the response immediately; the matching stream event may arrive later.
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
      await updateSession(result.data)
    },
    [agentName, updateSession, directory, isStopping, sessionId, workspaceId]
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
        description: error.message,
      })
    },
  })

  // Reverting stages the rolled-back turn's prompt in the composer to edit/resend.
  const handleRevert = useCallback(
    (messageID: string) => {
      revertMessage(messageID, {
        onSuccess: () => composerRef.current?.setMessage(composerMessageFor(messageID)),
      })
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
        description: error.message,
      })
    },
  })
  const restoringId = restoreMutation.isPending ? restoreMutation.variables : undefined
  // Sending must wait for a revert/restore to apply, else the prompt can race
  // ahead and run against the not-yet-reverted session, appending in place of
  // replacing the selected turn.
  const revertPending = isReverting || restoreMutation.isPending

  const [restoredInput, setRestoredInput] = useState<ChatInput>()
  const restoreInput = (item: ChatInput) => {
    const current = composerRef.current?.getMessage()
    if (current?.text || current?.files.length) {
      toast.error("Send or clear your current draft before restoring this message")
      return
    }
    const model = models.find(
      (entry) =>
        entry.modelID === item.content.model.modelID &&
        entry.providerID === item.content.model.providerID
    )
    if (model) {
      setModel(model.id)
      setVariant(item.content.model, item.content.variant)
      setReasoningLevel(item.content.variant ?? DEFAULT_REASONING_LEVEL)
    }
    if (coding && item.content.agent)
      setModeSelection({
        mode: item.content.agent,
        messageID: lastUser?.id,
        revertID: session?.revert?.messageID,
      })
    composerRef.current?.setMessage({
      text: item.content.text,
      files: item.content.attachments.map((file) => ({
        ...file,
        type: "file",
        source: "workspace",
      })),
    })
    setRestoredInput(item)
  }
  const handleStop = async () => {
    const result = await abortMessage()
    const recovered = result.items.find(
      (item) => item.state === "recovered" && item.author.id === authSession?.user.id
    )
    if (
      recovered &&
      !composerRef.current?.getMessage().text &&
      !composerRef.current?.getMessage().files.length
    )
      restoreInput(recovered)
  }
  const handleSubmit = async (
    message: PromptInputMessage,
    delivery: "steer" | "queue" = "steer"
  ) => {
    if (
      sessionUnavailable ||
      agentReadiness.isGettingReady ||
      isStopping ||
      revertPending ||
      (blocked && delivery === "steer")
    )
      throw new Error("Chat is not ready to send")
    if (isPending || (coding && (modeHistoryPending || !modeAvailable))) {
      const error = new Error(
        isPending || modeHistoryPending
          ? "Chat is still loading"
          : "The selected chat mode is unavailable"
      )
      toast.error(error.message)
      throw error
    }
    if (message.text.trim().length === 0 && message.files.length === 0) {
      toast.error("Message cannot be empty")
      return
    }
    if (delivery === "steer") {
      following.current = true
      setTimelineFollowing(true)
      setTimelineAtEnd(true)
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = requestAnimationFrame(() => {
        if (following.current) void timelineRef.current?.scrollToEnd({ animated: false })
      })
    }
    await sendMessage({
      requestID: message.requestID,
      delivery,
      agent: coding ? mode : undefined,
      files: message.files,
      model: selectedModel,
      sessionID: sessionId,
      text: message.text,
      variant: selectedReasoningVariant,
    })
    if (restoredInput) {
      setRestoredInput(undefined)
      try {
        await updateInput({ item: restoredInput, action: "remove" })
      } catch {
        toast.error("Message sent. The recovered copy could not be removed.")
      }
    }
    if (!selectedModel) return
    pushRecent({
      modelID: selectedModel.modelID,
      providerID: selectedModel.providerID,
    })
  }

  const handleModelSelect = (modelId: string) => {
    const selected = models.find((item) => item.id === modelId)
    if (!selected) return
    setModel(modelId)
    onDraftModelChange?.({ modelID: selected.modelID, providerID: selected.providerID })
    setReasoningLevel(DEFAULT_REASONING_LEVEL)
    setModelSelectorOpen(false)
  }

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

  const { activity, guardrailMessageID, reverted, rows } = useMemo(
    () =>
      projectTimeline({
        showWork,
        isBusy,
        isRetrying: sessionStatus?.type === "retry",
        messages,
        partsByMessage,
        revertMessageID: session?.revert?.messageID,
        textByPart,
      }),
    [
      showWork,
      isBusy,
      messages,
      partsByMessage,
      session?.revert?.messageID,
      sessionStatus?.type,
      textByPart,
    ]
  )
  // The first loaded rejection may itself include an older blocked prompt.
  // Find its preceding turn so automatic recovery removes the original cause.
  const guardrailHistoryPending =
    guardrailMessageID !== undefined &&
    hasEarlierMessages &&
    guardrailMessageID === messages.find((message) => message.role === "user")?.id
  useEffect(() => {
    if (guardrailHistoryPending && !isLoadingEarlier && !loadError) void loadEarlier()
  }, [guardrailHistoryPending, isLoadingEarlier, loadError, loadEarlier])
  const revertedAssistant = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.parentID === session?.revert?.messageID &&
      message.error
  )
  const revertedError =
    revertedAssistant?.role === "assistant"
      ? describeMessageError(revertedAssistant.error)
      : undefined
  const recoveredError = revertedError?.guardrail ? revertedError : undefined
  const handledGuardrail = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (
      !sessionId ||
      !guardrailMessageID ||
      guardrailHistoryPending ||
      isRefreshingHistory ||
      isBusy ||
      isStopping ||
      revertPending ||
      sendState
    )
      return
    const error = rows.findLast(
      (row) => row.type === "assistant-error" && row.revertMessageID === guardrailMessageID
    )
    if (!error || error.type !== "assistant-error") return
    const key = `${sessionId}:${error.key}`
    if (handledGuardrail.current === key) return
    // Restore each rejected turn once. An explicit restore in the revert dock
    // must not be immediately undone by another render of the same error.
    handledGuardrail.current = key
    const message = composerMessageFor(guardrailMessageID)
    revertMessage(guardrailMessageID, {
      onSuccess: () => {
        const draft = composerRef.current?.getMessage()
        // Preserve anything typed while the rejection and revert were in flight.
        if (!draft?.text && !draft?.files.length) composerRef.current?.setMessage(message)
      },
    })
  }, [
    sessionId,
    guardrailMessageID,
    guardrailHistoryPending,
    isRefreshingHistory,
    isBusy,
    isStopping,
    revertPending,
    sendState,
    rows,
    composerMessageFor,
    revertMessage,
  ])
  // SSE can render a prompt before either its submission or queue response.
  // Reconcile against visible rows so a header arriving before its parts does
  // not remove the pending bubble before the server bubble can replace it.
  const renderedInputs = new Set<string>()
  const renderedMessages = new Set<string>()
  for (const row of rows) {
    if (row.type !== "user") continue
    renderedInputs.add(row.key)
    renderedMessages.add(row.messageID)
  }
  const submissions = pendingMessages.filter((item) => !renderedInputs.has(`input:${item.id}`))
  const inputs = queue.filter(
    (item) =>
      item.state === "failed" ||
      item.state === "recovered" ||
      (!renderedInputs.has(`input:${item.id}`) && !renderedMessages.has(item.message_id ?? ""))
  )
  const activeSteers = inputs.filter(
    (item) =>
      item.delivery === "steer" &&
      !item.error &&
      (item.state === "queued" || item.state === "sending")
  )
  const pendingInputs = [
    ...submissions
      .filter(({ input }) => input.delivery === "steer")
      .map(({ id, input, progress }) => ({
        id,
        text: input.text,
        files: input.files,
        progress,
        author: authSession?.user,
      })),
    ...activeSteers
      .filter((item) => !submissions.some((pending) => pending.id === item.id))
      .map((item) => ({
        id: item.id,
        text: item.content.text,
        files: item.content.attachments,
        progress: undefined,
        author: item.author,
      })),
  ]
  const timelineRows = [
    ...rows,
    ...pendingInputs.map((input) => ({
      ...input,
      key: `input:${input.id}`,
      type: "pending" as const,
    })),
  ]

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
  const actorProfiles = useMemo(() => {
    const profiles = new Map(
      actorProfilesQuery.data?.profiles.map((profile) => [profile.id, profile]) ?? []
    )
    const user = authSession?.user
    // Queue acknowledgements omit photos; keep our known profile during delivery.
    if (user && !profiles.has(user.id))
      profiles.set(user.id, { id: user.id, name: user.name, image: user.image ?? null })
    return profiles
  }, [actorProfilesQuery.data, authSession?.user])
  const inputDisabled =
    sessionUnavailable ||
    agentReadiness.isGettingReady ||
    navigationPending ||
    (!sessionId && sendState === "submitted")
  const showStop = isBusy || isStopping || queue.some((item) => item.state !== "recovered")
  const submitDisabled =
    inputDisabled ||
    isPending ||
    isStopping ||
    revertPending ||
    !selectedModel ||
    !canSubmit ||
    (coding && (isPending || !modeAvailable || modeHistoryPending))
  const modeDisabled =
    inputDisabled ||
    isPending ||
    modeHistoryPending ||
    revertPending ||
    sendState === "submitted" ||
    !modes?.some((agent) => agent.name === nextMode)
  const toggleMode = () => {
    if (!coding || modeDisabled) return
    setModeSelection({
      mode: nextMode,
      messageID: lastUser?.id,
      revertID: session?.revert?.messageID,
    })
    onDraftModeChange?.(nextMode)
  }
  const showStarter =
    !hasSession && !isPending && rows.length === 0 && !sendState && pendingInputs.length === 0
  const showHistorySkeleton =
    isPending && rows.length === 0 && !showStarter && pendingInputs.length === 0
  const composerDock = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const dock = composerDock.current
    const root = dock?.parentElement
    if (!dock || !root || showStarter) return
    // Restore the list against its final footer inset before the first paint.
    let height = Math.ceil(dock.getBoundingClientRect().height)
    let publishedHeight = height
    root.style.setProperty("--chat-composer-height", `${height}px`)
    let frame: number | undefined
    const publishHeight = () => {
      // CSS owns intermediate geometry; publish the inset once it settles.
      const transitioning = dock
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.playState === "running" &&
            (animation.transitionProperty === "padding-bottom" ||
              animation.transitionProperty === "grid-template-rows")
        )
      if (transitioning || height === publishedHeight) return
      const grew = height > publishedHeight
      publishedHeight = height
      root.style.setProperty("--chat-composer-height", `${height}px`)
      if (!grew || !following.current) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (following.current) void timelineRef.current?.scrollToEnd({ animated: !reducedMotion })
      })
    }
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0]
      if (!box) return
      height = Math.ceil(box.blockSize)
      publishHeight()
    })
    observer.observe(dock)
    dock.addEventListener("transitionend", publishHeight)
    dock.addEventListener("transitioncancel", publishHeight)
    return () => {
      observer.disconnect()
      dock.removeEventListener("transitionend", publishHeight)
      dock.removeEventListener("transitioncancel", publishHeight)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [showStarter, reducedMotion])
  useLayoutEffect(
    () => () => {
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
      if (!sessionId || !scroll.current) return
      const info = sessionInfoQueryOptions(agentName, workspaceId, sessionId)
      // Logout clears metadata first; cleanup must not recreate a cleared cache.
      if (!queryClient.getQueryData(info.queryKey)) return
      const state = timelineRef.current?.getState()
      const [size] = Object.values(state?.getAverageItemSizes() ?? {})
      const key =
        state && [...state.sizes.keys()].find((key) => state.indexByKey(key) === state.start)
      queryClient.setQueryData<ChatScroll>(scrollQuery.queryKey, {
        ...scroll.current,
        atEnd: following.current,
        estimatedItemSize: size?.average,
        // Pixel offsets depend on the list's estimates. Preserve the visible
        // row and its position when measurements change between visits.
        anchor:
          state && key
            ? {
                key,
                viewOffset:
                  (state.positionByKey(key) ?? 0) +
                  timelineHeaderHeight.current -
                  scroll.current.offset,
              }
            : undefined,
      })
    },
    [agentName, queryClient, scrollQuery.queryKey, sessionId, workspaceId]
  )

  const initialAnchorIndex = initialScroll?.anchor
    ? timelineRows.findIndex((row) => row.key === initialScroll.anchor?.key)
    : -1

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-1 flex-col justify-end overflow-hidden"
      data-agentz-chat={sessionId ?? "new"}
    >
      <div
        className={cn("relative min-h-0 flex-1", showStarter && "pointer-events-none opacity-0")}
      >
        {!showStarter ? (
          <div className="relative h-full" aria-busy={showHistorySkeleton}>
            {showHistorySkeleton ? (
              <div className="absolute inset-0 mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-4">
                <Skeleton className="h-16 w-full rounded-md" />
                <Skeleton className="h-24 w-full rounded-md" />
                <Skeleton className="h-16 w-2/3 rounded-md" />
              </div>
            ) : null}
            {!showHistorySkeleton ? (
              <LegendList
                aria-label="Chat transcript"
                role="region"
                tabIndex={0}
                className="h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
                data={timelineRows}
                estimatedItemSize={initialScroll?.estimatedItemSize ?? 96}
                extraData={actorProfiles}
                initialScrollAtEnd={initialScroll?.atEnd ?? true}
                initialScrollOffset={initialAnchorIndex < 0 ? initialScroll?.offset : undefined}
                initialScrollIndex={
                  initialAnchorIndex >= 0
                    ? {
                        index: initialAnchorIndex,
                        viewOffset: initialScroll?.anchor?.viewOffset,
                      }
                    : undefined
                }
                keyExtractor={(row) => row.key}
                recycleItems={false}
                ListHeaderComponent={
                  hasEarlierMessages ? (
                    <div className="mx-auto w-[calc(100%-2rem)] max-w-3xl pt-4 pb-2">
                      <button
                        className="w-full py-1.5 text-xs text-muted-foreground/70 hover:text-foreground disabled:cursor-default"
                        disabled={isLoadingEarlier}
                        onClick={() => void loadEarlier()}
                        type="button"
                      >
                        {isLoadingEarlier ? "Loading earlier turns..." : "Load earlier turns"}
                      </button>
                    </div>
                  ) : (
                    <div className="h-4" />
                  )
                }
                ListFooterComponent={
                  <div
                    className="mx-auto flex w-[calc(100%-2rem)] max-w-3xl flex-col gap-4 pt-2"
                    style={{ paddingBottom: "calc(var(--chat-composer-height, 0px) + 16px)" }}
                  >
                    <RevertDock
                      items={reverted}
                      onRestore={restoreMutation.mutate}
                      pending={revertPending}
                      restoringId={restoringId}
                      summary={session?.summary}
                    />
                    {todos.length > 0 ? <TodoDock todos={todos} /> : null}
                  </div>
                }
                maintainScrollAtEnd={
                  timelineFollowing
                    ? {
                        animated: isBusy && !reducedMotion,
                        on: { dataChange: true, itemLayout: true, layout: true },
                      }
                    : false
                }
                maintainScrollAtEndThreshold={1}
                maintainVisibleContentPosition={{ data: true, size: true }}
                onMetricsChange={({ headerSize }) => {
                  timelineHeaderHeight.current = headerSize
                }}
                onLoad={() => {
                  timelineLoaded.current = true
                  const node = timelineRef.current?.getScrollableNode()
                  if (!node) return
                  // Align with measured DOM geometry before the list is revealed.
                  if (following.current) node.scrollTop = node.scrollHeight
                  else if (initialScroll?.atEnd === false && initialAnchorIndex < 0)
                    node.scrollTop = initialScroll.offset
                  scroll.current = { offset: node.scrollTop, atEnd: following.current }
                }}
                onWheel={(event) => {
                  if (event.ctrlKey || event.deltaY >= 0) return
                  const node = timelineRef.current?.getScrollableNode()
                  if (!node || node.scrollHeight <= node.clientHeight) return
                  // A nested code block owns wheel input while it can scroll.
                  let target = event.target instanceof Element ? event.target : null
                  while (target && target !== node) {
                    const css = getComputedStyle(target)
                    if (
                      (css.overflowY === "auto" || css.overflowY === "scroll") &&
                      (target.scrollTop > 0 ||
                        css.overscrollBehaviorY === "contain" ||
                        css.overscrollBehaviorY === "none")
                    )
                      return
                    target = target.parentElement
                  }
                  releaseFollow()
                }}
                onKeyDown={(event) => {
                  const target = event.target
                  if (
                    target instanceof HTMLElement &&
                    (target.isContentEditable || target.closest("input, textarea, select"))
                  )
                    return
                  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) releaseFollow()
                }}
                onTouchMove={releaseFollow}
                onPointerDown={(event) => {
                  const node = timelineRef.current?.getScrollableNode()
                  if (node && event.clientX >= node.getBoundingClientRect().left + node.clientWidth)
                    releaseFollow()
                }}
                onScroll={() => {
                  // Ignore estimated offsets until measured layout is ready.
                  if (!timelineLoaded.current) return
                  const node = timelineRef.current?.getScrollableNode()
                  if (!node) return
                  const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 40
                  if (!following.current && atEnd && !physicalEnd.current) {
                    following.current = true
                    setTimelineFollowing(true)
                  }
                  physicalEnd.current = atEnd
                  scroll.current = { offset: node.scrollTop, atEnd: following.current }
                  setTimelineAtEnd(following.current || atEnd)
                }}
                ref={timelineRef}
                renderItem={({ item }) => (
                  <div
                    className={cn(
                      "mx-auto w-[calc(100%-2rem)] max-w-3xl",
                      item.type === "checkpoint" ? "pb-1.5" : "pb-4"
                    )}
                  >
                    <TimelineRowView
                      workActive={
                        isBusy && !blocked && !streamError && sessionStatus?.type !== "retry"
                      }
                      agentName={agentName}
                      actorProfiles={actorProfiles}
                      onRevert={handleRevert}
                      revertDisabled={revertDisabled || isBusy || isStopping || revertPending}
                      row={item}
                      workspaceId={workspaceId}
                    />
                  </div>
                )}
              />
            ) : null}
          </div>
        ) : null}
        <NewItemsPill
          visible={!timelineAtEnd && !showStarter}
          latestId={rows.findLast((row) => row.type === "user" || row.type === "assistant")?.key}
          scope={sessionId ?? "new"}
          className="absolute left-1/2 z-20 -translate-x-1/2"
          style={{ bottom: "calc(var(--chat-composer-height, 0px) + 8px)" }}
          onClick={() => {
            following.current = true
            setTimelineFollowing(true)
            setTimelineAtEnd(true)
            scrollFrame.current = requestAnimationFrame(() => {
              void timelineRef.current?.scrollToEnd({
                animated: !reducedMotion,
              })
            })
          }}
          size="icon"
          variant="outline"
        />
        {!showStarter ? (
          <QuickTurnNav listRef={timelineRef} rows={rows} onNavigate={releaseFollow} />
        ) : null}
      </div>
      <div
        ref={composerDock}
        className={cn(
          "pointer-events-none absolute inset-x-0 z-30 flex max-h-full min-h-0 flex-col gap-4 px-3 sm:px-5",
          showStarter ? "top-1/2 -translate-y-1/2" : "bottom-0 bg-background pb-4"
        )}
      >
        <div
          className={cn(
            "pointer-events-auto mx-auto flex min-h-0 w-full max-w-3xl flex-col",
            showStarter ? "gap-8" : "min-w-0 bg-background"
          )}
        >
          {showStarter ? (
            <NewSessionGreeting
              projectName={projectName}
              firstName={firstName}
              greetingIndex={greetingIndex}
            />
          ) : null}
          {permissionRequest || questionRequest ? (
            <div className="flex min-h-0 flex-col">
              {permissionRequest ? (
                <PermissionDock
                  onDecide={(reply) => {
                    void replyPermission(reply)
                  }}
                  pending={isPermissionPending}
                  request={permissionRequest}
                />
              ) : null}
              {questionRequest && planApproval && session ? (
                <PlanDock
                  agentName={agentName}
                  key={questionRequest.id}
                  onSubmit={submitQuestionAnswer}
                  pending={isQuestionPending}
                  request={questionRequest}
                  session={session}
                  workspaceId={workspaceId}
                />
              ) : null}

              {questionRequest && !planApproval && authSession ? (
                <QuestionDock
                  key={`${authSession.user.id}:${questionRequest.id}`}
                  agentName={agentName}
                  workspaceId={workspaceId}
                  userID={authSession.user.id}
                  onReject={rejectQuestion}
                  onSubmit={answerQuestion}
                  pending={isQuestionPending || isQuestionRejectPending}
                  request={questionRequest}
                />
              ) : null}
            </div>
          ) : null}
          <ChatQueue
            items={inputs.filter((item) => !activeSteers.includes(item))}
            submissions={submissions.filter(({ input }) => input.delivery === "queue")}
            error={queueError}
            userID={authSession?.user.id}
            coding={coding}
            onUpdate={updateInput}
            onRestore={restoreInput}
          />
          {recoveredError ? (
            <Alert className="mb-3" variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{recoveredError.label}</AlertTitle>
              {recoveredError.body ? (
                <AlertDescription>{recoveredError.body}</AlertDescription>
              ) : null}
            </Alert>
          ) : null}
          {isBusy &&
          !activity?.responding &&
          (!showWork ||
            blocked ||
            streamError ||
            sessionStatus?.type === "retry" ||
            !rows.some(
              (row) =>
                row.type === "assistant" &&
                row.isStreaming &&
                row.entries.some((entry) => entry.type === "work")
            )) ? (
            <div className="mb-3 flex min-h-12 items-center gap-2" role="status" aria-live="polite">
              <AgentPresence
                state={
                  streamError || blocked || sessionStatus?.type === "retry"
                    ? "waiting"
                    : activity?.thinking
                      ? "thinking"
                      : "working"
                }
                size={44}
              />
              {streamError || blocked || sessionStatus?.type === "retry" ? (
                <span className="text-sm text-muted-foreground">
                  {streamError
                    ? "Reconnecting"
                    : permissionRequest
                      ? "Waiting for approval"
                      : questionRequest
                        ? "Waiting for your answer"
                        : "Waiting to retry"}
                </span>
              ) : (
                <WorkingShimmer
                  text={showWork && activity?.thinking ? "Thinking" : activity?.text}
                />
              )}
            </div>
          ) : null}
          <div className={cn(styles.shell, "relative w-full shrink-0")}>
            <ChatPromptInput
              draftKey={draftKey}
              initialMessage={initialMessage}
              onMessageChange={(message) => {
                if (!sessionId) onDraftChange?.(message)
              }}
              className={cn(styles.host, "relative z-10 rounded-3xl")}
              controllerRef={composerRef}
              disabled={inputDisabled}
              globalDrop
              maxFileSize={chatAttachmentConfig.maxFileSizeBytes}
              maxFiles={chatAttachmentConfig.maxFileCount}
              mobile={promptMobile}
              multiple
              onError={(code) => {
                toast.error(chatAttachmentErrorMessage(code))
              }}
              onSubmit={(message) => handleSubmit(message)}
              onQueue={(message) => handleSubmit(message, "queue")}
            >
              <PromptInputAttachmentsDisplay agentName={agentName} />
              <PromptInputBody
                className={cn(
                  styles.body,
                  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-4 sm:px-5"
                )}
                data-reading={!timelineFollowing && !showStarter ? true : undefined}
              >
                <div
                  className={cn(
                    "col-start-2 row-start-2 flex items-center gap-1",
                    coding && "border-l border-border/70 pl-2"
                  )}
                >
                  {coding ? (
                    <PromptInputButton
                      aria-label="Chat mode"
                      aria-pressed={mode === "plan"}
                      aria-keyshortcuts="Shift+Tab"
                      className={cn(
                        "h-8 w-18 justify-start gap-1.5 rounded-lg px-2.5 text-xs transition-colors",
                        mode === "plan"
                          ? "bg-accent text-accent-foreground hover:bg-accent/80"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      disabled={modeDisabled}
                      onClick={toggleMode}
                      tooltip={{
                        content: modes?.some((agent) => agent.name === nextMode)
                          ? `Switch to ${nextMode === "plan" ? "Plan" : "Build"}`
                          : "Chat mode unavailable",
                        shortcut: "Shift+Tab",
                      }}
                    >
                      {mode === "plan" ? <PencilRulerIcon /> : <HammerIcon />}
                      {mode === "plan" ? "Plan" : mode === "build" ? "Build" : mode}
                    </PromptInputButton>
                  ) : null}
                </div>
                <PromptInputTextarea
                  defaultValue={draftMessage?.text}
                  className="col-span-full col-start-1 row-start-1 self-stretch px-0 py-0 text-[15px] leading-6 placeholder:text-muted-foreground/80"
                  disabled={inputDisabled}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Tab" &&
                      !event.shiftKey &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      if (
                        !event.currentTarget.value.trim() &&
                        !composerRef.current?.getMessage().files.length
                      )
                        return
                      if (event.repeat) {
                        event.preventDefault()
                        return
                      }
                      event.preventDefault()
                      composerRef.current?.submit(true)
                      return
                    }
                    if (
                      !coding ||
                      modeDisabled ||
                      event.key !== "Tab" ||
                      !event.shiftKey ||
                      event.altKey ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.nativeEvent.isComposing
                    )
                      return
                    event.preventDefault()
                    if (!event.repeat) toggleMode()
                  }}
                />
                <div className="contents">
                  <div className="col-start-1 row-start-2 min-w-0">
                    <Dialog
                      onOpenChange={setModelSelectorOpen}
                      open={agentReadiness.isGettingReady ? false : modelSelectorOpen}
                    >
                      <div
                        className={cn(
                          "hidden min-w-0 items-center justify-start gap-2",
                          !promptMobile && "@xl/chat:flex"
                        )}
                      >
                        <DialogTrigger asChild>
                          <PromptInputButton
                            className="h-8 max-w-56 justify-start px-1.5 text-muted-foreground"
                            disabled={inputDisabled}
                          >
                            {agentReadiness.isGettingReady ? (
                              <AgentGettingReady />
                            ) : (
                              <ProviderIcons providers={modelBrands.get(selectedModelID) ?? []} />
                            )}
                            {agentReadiness.isGettingReady ? null : selectedModel?.name ? (
                              <span className="flex-1 truncate text-left">
                                {selectedModel.name}
                              </span>
                            ) : (
                              <span className="flex-1 truncate text-left">Model</span>
                            )}
                            {agentReadiness.isGettingReady ? null : (
                              <ChevronDownIcon data-icon="inline-end" />
                            )}
                          </PromptInputButton>
                        </DialogTrigger>
                        {!agentReadiness.isGettingReady && reasoningVariants.length > 0 ? (
                          <Select
                            disabled={inputDisabled}
                            onValueChange={handleReasoningLevelChange}
                            value={selectedReasoningLevel}
                          >
                            <ReasoningSelectTrigger
                              aria-label="Reasoning level"
                              className="h-8 min-w-16 gap-1.5 px-2 text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
                              size="sm"
                              variant="ghost"
                            >
                              <GaugeIcon />
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
                        className={cn(
                          "justify-start",
                          promptMobile ? "flex" : "flex @xl/chat:hidden"
                        )}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <PromptInputButton
                              aria-label="Chat options"
                              className="size-8"
                              disabled={inputDisabled}
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
                                onSelect={(event) => {
                                  event.preventDefault()
                                  setModelSelectorOpen(true)
                                }}
                              >
                                <ProviderIcons providers={modelBrands.get(selectedModelID) ?? []} />
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
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <DialogContent
                        aria-describedby={undefined}
                        className="border-none! p-0 outline! outline-border! outline-solid!"
                      >
                        <DialogTitle className="sr-only">Model Selector</DialogTitle>
                        <Command className="**:data-[slot=command-input-wrapper]:h-auto">
                          <CommandInput className="h-auto py-3.5" placeholder="Search models..." />
                          <CommandList>
                            <CommandEmpty>No models found.</CommandEmpty>
                            {chefs.map((chef) => (
                              <CommandGroup heading={chef} key={chef}>
                                {models
                                  .filter((item) => item.chef === chef)
                                  .map((item) => (
                                    <CommandItem
                                      key={item.id}
                                      onSelect={handleModelSelect}
                                      value={item.id}
                                    >
                                      <ProviderIcons providers={modelBrands.get(item.id) ?? []} />
                                      <span className="flex-1 truncate text-left">{item.name}</span>
                                      {selectedModelID === item.id ? (
                                        <CheckIcon className="ml-auto" />
                                      ) : (
                                        <div className="ml-auto size-4" />
                                      )}
                                    </CommandItem>
                                  ))}
                              </CommandGroup>
                            ))}
                          </CommandList>
                        </Command>
                      </DialogContent>
                    </Dialog>
                  </div>
                  <div
                    className={cn(
                      styles.actions,
                      "col-start-3 row-start-2 flex items-center gap-2"
                    )}
                  >
                    <PromptInputAttachmentButton disabled={inputDisabled} />
                    {!agentReadiness.isGettingReady &&
                    contextUsage?.maxTokens &&
                    contextUsage.maxTokens > 0 ? (
                      <Context
                        maxTokens={contextUsage.maxTokens}
                        usage={contextUsage.usage}
                        usedTokens={contextUsage.usedTokens}
                      />
                    ) : null}
                    <Button
                      type={showStop ? "button" : "submit"}
                      variant={showStop ? "destructive" : "default"}
                      size="icon"
                      className="size-10 rounded-full shadow-none transition-colors disabled:opacity-40"
                      aria-label={showStop ? "Stop run" : "Send message"}
                      disabled={showStop ? inputDisabled || !canStop : submitDisabled || blocked}
                      onClick={showStop ? () => void handleStop() : undefined}
                    >
                      {showStop ? (
                        <SquareIcon className="size-3.5 fill-current" />
                      ) : (
                        <ArrowUpIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </PromptInputBody>
            </ChatPromptInput>
            <div
              className={cn(
                styles.context,
                "absolute inset-x-5.5 bottom-0 z-0 flex h-10 items-end gap-2 px-3 pb-1"
              )}
            >
              <Select
                disabled={hasSession || sendState === "submitted" || agentNames.length < 2}
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
                  className="h-7 max-w-64 min-w-0 border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-foreground/5"
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
              {composerContext?.(inputDisabled || hasSession || sendState === "submitted")}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function QuickTurnNav({
  listRef,
  rows,
  onNavigate,
}: {
  listRef: RefObject<LegendListRef | null>
  rows: TimelineRow[]
  onNavigate: () => void
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
        "pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 pointer-fine:block",
        gutter >= 48
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100"
      )}
      ref={navRef}
    >
      <button
        aria-label={`Jump to message: ${selected?.text || "Attachment"}`}
        className={cn(
          "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none",
          hitWidth > 0 ? "pointer-events-auto" : "pointer-events-none"
        )}
        onBlur={() => setActive(undefined)}
        onClick={(event) => {
          const turn = turns[turnIndexAt(event.clientY, event.currentTarget)]
          if (!turn) return

          onNavigate()
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
            onNavigate()
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
        <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
        {turns.map((turn, index) => (
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150",
              active === index
                ? "w-6 bg-muted-foreground/75"
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
            <span className="block rounded-xl bg-popover/90 p-3 text-left text-popover-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur-xl">
              <span className="block truncate text-sm leading-5 font-medium">
                {selected.text || "Attachment"}
              </span>
              {previewWords?.length ? (
                <span className="mt-1 block text-sm leading-5 text-muted-foreground">
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
  workActive,
  agentName,
  actorProfiles,
  onRevert,
  revertDisabled,
  row,
  workspaceId,
}: {
  workActive: boolean
  agentName: string
  actorProfiles: Map<string, MessageActorProfile>
  onRevert: (messageID: string) => void
  revertDisabled: boolean
  row: TimelineRow | PendingTimelineRow
  workspaceId: string
}) {
  const { previewFile } = useFileWorkspace()
  const openAgentFile = useCallback(
    (path: string, name: string) => {
      previewFile(agentName, { name, path })
    },
    [agentName, previewFile]
  )

  switch (row.type) {
    case "pending":
    case "user": {
      const actor = row.type === "pending" ? row.author : row.actor
      const user = row.type === "pending" || row.actor?.type === "user"
      const profile = user && actor ? actorProfiles.get(actor.id) : undefined
      const name = profile?.name ?? actor?.name
      const kind = user ? "User" : row.actor?.type === "api_key" ? "API key" : "System"
      const label = actor ? `${name} · ${kind}` : undefined
      let image = row.type === "pending" ? row.author?.image : undefined
      if (profile) image = profile.image

      return (
        <ChatMessage
          from="user"
          aria-label={row.type === "pending" ? "Pending message" : undefined}
          avatar={
            name && label ? <UserMessageAvatar image={image} label={label} name={name} /> : null
          }
          footer={
            <>
              {row.type === "pending" ? (
                <div className="flex h-6 w-full max-w-[80%] items-center justify-end pe-11 text-xs text-muted-foreground">
                  {row.progress ? <span role="status">{row.progress}</span> : null}
                </div>
              ) : row.isWaiting ? (
                <div role="status" className="pe-11 text-xs text-muted-foreground">
                  Waiting for the current step...
                </div>
              ) : null}
              {row.type === "user" ? (
                <div className="flex w-full max-w-[80%] items-center justify-end gap-2 pe-11 text-xs tabular-nums opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
                  <RelativeDateTime value={row.createdAt} />
                  <div className="flex items-center gap-0.5">
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
                  </div>
                </div>
              ) : null}
            </>
          }
        >
          {row.type === "pending" ? (
            row.files.map((file, index) => (
              <div key={index} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <PaperclipIcon className="size-3.5" />
                {file.filename}
              </div>
            ))
          ) : row.attachments.length > 0 ? (
            <Attachments className="gap-[6px]" variant="composer">
              {row.attachments.map((attachment) => (
                <StoredAttachment
                  agentName={agentName}
                  attachment={attachment}
                  key={attachment.id}
                  onOpen={openAgentFile}
                  workspaceId={workspaceId}
                />
              ))}
            </Attachments>
          ) : null}
          {row.text.length > 0 ? <MessageResponse>{row.text}</MessageResponse> : null}
        </ChatMessage>
      )
    }

    case "assistant": {
      const showMeta = !row.isStreaming
      const copyText = row.entries
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.content)
        .join("\n\n")
      return (
        <ChatMessage
          from="assistant"
          footer={
            <div className="mt-1.5 flex min-h-6 items-center gap-1 px-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
              {showMeta ? (
                <>
                  <RelativeDateTime className="text-xs" value={row.createdAt} />
                  {copyText.length > 0 ? <CopyButton content={copyText} /> : null}
                </>
              ) : null}
            </div>
          }
        >
          {row.entries.map((entry) => {
            if (entry.type === "work")
              return (
                <WorkGroup
                  key={entry.key}
                  parts={entry.parts}
                  active={workActive && row.isStreaming && row.entries.at(-1) === entry}
                  scope={`${workspaceId}:${agentName}:${row.key}`}
                  onAgentFileOpen={openAgentFile}
                />
              )
            if (entry.type === "text")
              return (
                <MessageResponse key={entry.key} onAgentFileOpen={openAgentFile}>
                  {entry.content}
                </MessageResponse>
              )
            if (entry.type === "question")
              return (
                <div className="my-4 space-y-3 text-sm" key={entry.key}>
                  {entry.questions.map(({ question }, index) => (
                    <div className="space-y-1" key={index}>
                      <p className="text-muted-foreground">{question}</p>
                      <p className="flex items-start gap-2">
                        {!entry.dismissed && entry.answers[index]?.length ? (
                          <CheckIcon
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        <span>
                          {entry.dismissed
                            ? "Question dismissed"
                            : entry.answers[index]?.length
                              ? `User answered: ${entry.answers[index].join(", ")}`
                              : "Question skipped"}
                        </span>
                      </p>
                    </div>
                  ))}
                </div>
              )
            return (
              <Attachments key={entry.key} variant="grid">
                {entry.files.map((file) => (
                  <Attachment
                    key={file.id}
                    data={{
                      id: file.id,
                      type: "file",
                      filename: file.filename ?? "File",
                      mediaType: file.mime,
                      url: file.url,
                    }}
                    onOpen={() => {
                      if (file.url.startsWith("file://"))
                        openAgentFile(
                          decodeURIComponent(new URL(file.url).pathname),
                          file.filename ?? "File"
                        )
                      else window.open(file.url, "_blank", "noopener,noreferrer")
                    }}
                  >
                    <AttachmentPreview />
                  </Attachment>
                ))}
              </Attachments>
            )
          })}
        </ChatMessage>
      )
    }

    case "checkpoint": {
      return (
        <div className="flex flex-col gap-2 text-muted-foreground">
          <div className="flex items-center gap-0.5">
            <BookmarkIcon className="size-4 shrink-0" />
            <span className="text-xs">
              {row.variant === "compaction" ? "Context compacted" : "Interrupted"}
            </span>
          </div>
          <Separator />
        </div>
      )
    }

    case "assistant-error": {
      return (
        <Alert className="mx-auto w-fit max-w-full" variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{row.label}</AlertTitle>
          {row.body || row.partialOutput ? (
            <AlertDescription>
              <p>
                {row.body}
                {row.partialOutput ? " The response above is incomplete." : null}
              </p>
            </AlertDescription>
          ) : null}
        </Alert>
      )
    }
  }
}
