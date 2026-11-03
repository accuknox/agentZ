"use client"

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Collapsible as CollapsiblePrimitive } from "radix-ui"
import { ExpandingSearch } from "@/components/interior/expanding-search"
import { LoadMore } from "@/components/interior/load-more"

import { LoadingButton } from "@/components/interior/loading-button"
import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { GitHubDark, GitHubLight } from "@ridemountainpig/svgl-react"
import {
  experimental_streamedQuery as streamedQuery,
  infiniteQueryOptions,
  hashKey,
  queryOptions,
  replaceEqualDeep,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import {
  Archive,
  ArchiveRestore,
  Copy,
  AlarmClock,
  AlarmClockOff,
  Activity,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CirclePause,
  FolderGit2,
  Pencil,
  Layers3,
  ListFilter,
  LoaderCircle,
  Plus,
  RotateCcw,
  Rows3,
  Search,
  Settings2,
  SquarePen,
  Trash2,
  Users,
  X,
  CircleAlert,
} from "lucide-react"
import { nanoid } from "nanoid"
import {
  memo,
  useActionState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Projects, ProjectPicker, type ProjectActions } from "@/components/blocks/coding/projects"
import { authClient } from "@/lib/auth-client"
import { codingGitOptions, codingThreadOptions } from "@/lib/coding/review"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { sessionDrafts, useSessionDrafts, type SessionDraft } from "@/components/blocks/chat/drafts"

import { deleteAgentSessionAction } from "@/data/opencode.actions"
import type { DeleteSessionFormState, ListAgentActionResponse, WorkspacePath } from "@/data/types"
import {
  AgentIcon,
  agentIsGettingReady,
  watchAgentsQueryOptions,
} from "@/components/agent-readiness"
import { AgentAvatar } from "@/components/interior/agent-presence"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AlertDescription, Alert } from "@/components/ui/alert"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { PresenceAvatars } from "@/components/interior/presence-avatars"
import {
  sessionDiffQueryOptions,
  sessionInfoQueryOptions,
  sessionMessagesQueryOptions,
  removeSessionState,
} from "@/components/blocks/chat/use-opencode-chat"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarMenuSub, SidebarMenuSubItem, useSidebar } from "@/components/ui/sidebar"
import { dayjs, formatShortAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { cn } from "@/lib/utils"
import {
  updateChatSession,
  type ChatSessionShelf,
  type UpdateChatSessionRequest,
  listChatSessions,
  getChatSessionPreference,
  getCodingThread,
  listCodingProjects,
  updateChatSessionPreference,
  watchChatSessions,
  type CodingProject,
  type ChatSession,
  type ChatSessionGroup,
  type ChatSessionGroupBy,
  type ChatSessionPreference,
  type AgentStatus,
  type Workspace,
  type ListChatSessionsResponse,
  type WatchChatSessionsEvent,
} from "@/lib/gateway/client"

type PreferenceMutation = {
  next: ChatSessionPreference
  key: readonly [...ReturnType<typeof chatSessionKeys.preference>, string]
  version: number
  save: { version: number; value: ChatSessionPreference }
}

type NavSessionsProps = {
  userId: string
  workspaceType: Workspace["type"]
  agents: ListAgentActionResponse
  initialPreferences: ChatSessionPreference
  initialSessions: ListChatSessionsResponse
  workspaceId: string
  workspacePath: WorkspacePath
}

const allAgentsValue = "__all_agents__"
const chatDeletionSource = nanoid()

const chatSessionKeys = {
  preference: (workspaceId: string) => ["chatSessionPreference", workspaceId] as const,
  workspace: (workspaceId: string) => ["chatSessions", workspaceId] as const,
  list: (
    workspaceId: string,
    preferences: ChatSessionPreference,
    search: string,
    timeZone: string
  ) =>
    [
      "chatSessions",
      workspaceId,
      "list",
      preferences.agent_name,
      preferences.include_workflow_runs,
      preferences.participant_user_ids,
      preferences.group_by,
      search,
      timeZone,
    ] as const,
  group: (
    workspaceId: string,
    preferences: ChatSessionPreference,
    key: string,
    search: string,
    timeZone: string,
    activeAgentName: string | undefined,
    activeSessionId: string | undefined
  ) =>
    [
      "chatSessions",
      workspaceId,
      "group",
      key,
      preferences.agent_name,
      preferences.include_workflow_runs,
      preferences.participant_user_ids,
      search,
      timeZone,
      activeAgentName,
      activeSessionId,
    ] as const,
}

function chatSessionsOptions(
  workspaceId: string,
  preferences: ChatSessionPreference,
  search: string,
  timeZone: string,
  activeAgentName: string | undefined,
  activeSessionId: string | undefined,
  userId: string,
  shelf: ChatSessionShelf
) {
  const queryKey = [
    ...chatSessionKeys.list(workspaceId, preferences, search, timeZone),
    userId,
    shelf,
    preferences.group_by === "none" ? null : { activeAgentName, activeSessionId },
  ] as const
  return infiniteQueryOptions({
    queryKey,
    initialPageParam: undefined,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined
      signal: AbortSignal
    }) => {
      const result = await listChatSessions({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        query: {
          shelf,
          agent_name: preferences.agent_name ?? undefined,
          include_workflow_runs: preferences.include_workflow_runs,
          group_by: preferences.group_by,
          search: search || undefined,
          time_zone: preferences.group_by === "date" ? timeZone : undefined,
          active_agent_name: preferences.group_by === "none" ? undefined : activeAgentName,
          active_session_id: preferences.group_by === "none" ? undefined : activeSessionId,
          limit: pageParam ? 25 : 10,
          include_filter_options: shelf === "active" && pageParam === undefined,
          page_token: pageParam,
          participant_user_id: preferences.participant_user_ids,
        },
        signal,
      })
      if (result.error) throw result.error
      return result.data
    },
    getNextPageParam: (page) => (page.has_next_page ? page.next_page_token : undefined),

    // Selection only changes group expansion hints. Filters and shelves must
    // never inherit another list's rows while their request is pending.
    placeholderData: (previous, query) =>
      query && hashKey(query.queryKey.slice(0, -1)) === hashKey(queryKey.slice(0, -1))
        ? previous
        : undefined,
    staleTime: Infinity,
  })
}

async function removeChatSessionFromCache(
  queryClient: QueryClient,
  workspaceId: string,
  session: Pick<ChatSession, "agent_name" | "session_id">,
  keepShelf?: ChatSessionShelf
) {
  const queryKey = chatSessionKeys.workspace(workspaceId)
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueriesData<InfiniteData<ListChatSessionsResponse>>(
    {
      queryKey,
      predicate: (query) => query.queryKey[2] === "list" && query.queryKey.at(-2) !== keepShelf,
    },
    (current) =>
      current && {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          sessions: page.sessions.filter(
            (entry) =>
              entry.agent_name !== session.agent_name || entry.session_id !== session.session_id
          ),
          groups: page.groups.map((group) => ({
            ...group,
            sessions: group.sessions.filter(
              (entry) =>
                entry.agent_name !== session.agent_name || entry.session_id !== session.session_id
            ),
          })),
        })),
      }
  )
  queryClient.setQueriesData<InfiniteData<ChatSessionGroup>>(
    { queryKey, predicate: (query) => query.queryKey[2] === "group" && keepShelf !== "active" },
    (current) =>
      current && {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          sessions: page.sessions.filter(
            (entry) =>
              entry.agent_name !== session.agent_name || entry.session_id !== session.session_id
          ),
        })),
      }
  )
}

export function NavSessions({
  userId,
  agents,
  initialPreferences,
  initialSessions,
  workspaceId,
  workspaceType,
  workspacePath,
}: NavSessionsProps) {
  if (workspaceType === "coding") {
    return (
      <Projects
        projects={[]}
        agentNames={(agents.agents ?? [])
          .filter((agent) => agent.capabilities.use)
          .map((agent) => agent.name)}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
      >
        {(actions) => (
          <NavSessionsContent
            userId={userId}
            workspaceType={workspaceType}
            agents={agents}
            initialPreferences={initialPreferences}
            initialSessions={initialSessions}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            projectActions={actions}
          />
        )}
      </Projects>
    )
  }
  return (
    <NavSessionsContent
      userId={userId}
      workspaceType={workspaceType}
      agents={agents}
      initialPreferences={initialPreferences}
      initialSessions={initialSessions}
      workspaceId={workspaceId}
      workspacePath={workspacePath}
    />
  )
}

export function NavSessionsSkeleton({
  groupBy,
  coding,
}: {
  groupBy: ChatSessionGroupBy
  coding: boolean
}) {
  return (
    <div className="flex flex-col" data-tour="loading-chats">
      <div
        aria-hidden="true"
        className="flex h-9 items-center gap-1 px-(--sidebar-content-inset) pb-1"
      >
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2">
          <Skeleton className="size-4 shrink-0 rounded-sm bg-sidebar-border" />
          <Skeleton className="h-4 w-20 bg-sidebar-border" />
        </div>
        <div className="grid size-8 shrink-0 place-items-center">
          <Skeleton className="size-4 rounded-sm bg-sidebar-border" />
        </div>
        <div className="grid size-8 shrink-0 place-items-center">
          <Skeleton className="size-4 rounded-sm bg-sidebar-border" />
        </div>
      </div>
      <div className="px-(--sidebar-content-inset) pb-2">
        <SessionListSkeleton groupBy={groupBy} coding={coding} />
      </div>
    </div>
  )
}

function NavSessionsContent({
  userId,
  projectActions,
  agents,
  initialPreferences,
  initialSessions,
  workspaceId,
  workspaceType,
  workspacePath,
}: NavSessionsProps & { projectActions?: ProjectActions }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const path = usePathname()
  const [initialPath] = useState(path)
  const query = useSearchParams()
  const { isMobile, setOpenMobile } = useSidebar()
  const draftScope = `${userId}:${workspaceId}`
  const drafts = useSessionDrafts(draftScope)
  const discardDraft = (draft: SessionDraft) => {
    if (sessionDrafts.get(draftScope, draft.id)?.submission) return
    void navigator.locks.request(
      `agentz-draft:${JSON.stringify([draftScope, draft.id])}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) {
          toast.error("This draft is being sent in another tab")
          return
        }
        sessionDrafts.remove(draftScope, draft.id)
        queryClient.removeQueries({
          ...queryOptions({
            queryKey: ["chatDraft", workspaceId, draft.agentName, userId, draft.id],
          }),
          exact: true,
        })
        if (query.get("draft") !== draft.id) return
        const search = new URLSearchParams({ agent: draft.agentName, draft: nanoid() })
        window.history.pushState(null, "", `${workspacePath}/sessions/new?${search}`)
      }
    )
  }
  const [pickingProject, setPickingProject] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState("")
  const [search, setSearch] = useState("")
  const [timeZone] = useState(() => dayjs.tz.guess())
  const [dateBoundary, setDateBoundary] = useState(0)
  const [groupExpansion, setGroupExpansion] = useState<Map<string, boolean>>(() => new Map())
  const expansionKey = `coding-projects:${draftScope}`
  const savedExpansion = useSyncExternalStore(
    (listener) => {
      window.addEventListener("storage", listener)
      return () => window.removeEventListener("storage", listener)
    },
    () => {
      try {
        return window.localStorage.getItem(expansionKey) ?? "{}"
      } catch {
        return "{}"
      }
    },
    () => "{}"
  )
  const projectExpansion = useMemo<Record<string, boolean>>(() => {
    try {
      return JSON.parse(savedExpansion)
    } catch {
      return {}
    }
  }, [savedExpansion])
  const searchInput = useRef<HTMLInputElement>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const trimmedSearch = searchText.trim()
  const searchLength = Array.from(trimmedSearch).length
  const sessionPrefix = `${workspacePath}/agents/`
  const sessionPath = path.startsWith(sessionPrefix)
    ? path.slice(sessionPrefix.length).split("/")
    : []
  const [encodedAgentName, sessionSegment, encodedSessionId] = sessionPath
  const activeAgentName =
    sessionSegment === "sessions" && encodedAgentName && encodedSessionId
      ? decodeURIComponent(encodedAgentName)
      : undefined
  const activeSessionId =
    sessionSegment === "sessions" && encodedAgentName && encodedSessionId
      ? decodeURIComponent(encodedSessionId)
      : undefined

  useEffect(() => {
    if (!searchOpen) return
    searchInput.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        setSearch(
          searchLength === 0 || (searchLength >= 3 && searchLength <= 200) ? trimmedSearch : ""
        ),
      250
    )
    return () => window.clearTimeout(timer)
  }, [searchLength, trimmedSearch])

  const querySearch = trimmedSearch === search ? search : ""
  const preferenceKey = [...chatSessionKeys.preference(workspaceId), userId] as const
  const preference = useQuery({
    ...queryOptions({
      queryKey: preferenceKey,
      queryFn: async () => {
        const result = await getChatSessionPreference({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
        })
        if (result.error) throw result.error
        return result.data
      },
      staleTime: Infinity,
    }),
    initialData: initialPreferences,
  })
  const preferences = preference.data
  const preferenceSaves = useRef(new Map<string, PreferenceMutation["save"]>())
  const projects = useQuery(
    queryOptions({
      queryKey: ["chatSessions", workspaceId, "projects", userId],
      queryFn: async ({ signal }) => {
        const result = await listCodingProjects({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
        })
        if (result.error) throw result.error
        return result.data
      },
      enabled: workspaceType === "coding",
      staleTime: Infinity,
    })
  )
  const agentQuery = useQuery({
    ...watchAgentsQueryOptions(workspaceId, agents.agents ?? []),
    enabled: agents.agents !== undefined,
  })
  const availableAgents = agentQuery.data ?? agents.agents ?? []
  const matchesInitialPreferences =
    preferences.agent_name === initialPreferences.agent_name &&
    preferences.include_workflow_runs === initialPreferences.include_workflow_runs &&
    preferences.group_by === initialPreferences.group_by &&
    preferences.participant_user_ids.length === initialPreferences.participant_user_ids.length &&
    preferences.participant_user_ids.every(
      (id, index) => id === initialPreferences.participant_user_ids[index]
    )
  const watch = useQuery(chatSessionWatchOptions(workspaceId, userId))
  const sessions = useInfiniteQuery({
    ...chatSessionsOptions(
      workspaceId,
      preferences,
      querySearch,
      timeZone,
      activeAgentName,
      activeSessionId,
      userId,
      "active"
    ),
    enabled:
      trimmedSearch === querySearch &&
      (searchLength === 0 || (searchLength >= 3 && searchLength <= 200)) &&
      (preferences.group_by !== "date" || timeZone !== ""),
    initialData:
      !watch.data &&
      path === initialPath &&
      matchesInitialPreferences &&
      querySearch === "" &&
      preferences.group_by !== "date" &&
      (preferences.group_by === "none" ||
        (activeAgentName === undefined && activeSessionId === undefined))
        ? { pages: [initialSessions], pageParams: [undefined] }
        : undefined,
  })
  const mutation = useMutation({
    scope: { id: `chat-preferences:${userId}:${workspaceId}` },
    mutationFn: async ({ next, key }: PreferenceMutation) => {
      const result = await updateChatSessionPreference({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": key[1] },
        body: next,
      })
      if (result.error) throw result.error
      return result.data
    },
    onError: (_, { key, save, version }) => {
      if (save.version !== version) return
      queryClient.setQueryData(key, save.value)
      toast.error("Could not save chat filters")
    },
    onSuccess: (value, { key, save, version }) => {
      save.value = value
      if (save.version !== version) return
      queryClient.setQueryData(key, value)
    },
  })
  useEffect(() => {
    const channel = new BroadcastChannel(`chatSessionDeletion:${workspaceId}`)
    channel.onmessage = (
      event: MessageEvent<Pick<ChatSession, "agent_name" | "session_id"> & { source?: string }>
    ) => {
      if (event.data.source === chatDeletionSource) return
      void removeSessionState(
        queryClient,
        event.data.agent_name,
        workspaceId,
        event.data.session_id
      )
      void removeChatSessionFromCache(queryClient, workspaceId, event.data)
    }
    return () => channel.close()
  }, [queryClient, workspaceId])

  useEffect(() => {
    if (!watch.data) return
    // A draft has no native chat stream. Mark inactive snapshots uncertain so
    // returning to them validates changes made by other users while away.
    void queryClient.invalidateQueries({
      type: "inactive",
      predicate: (query) =>
        query.queryKey[0] === "opencode" &&
        query.queryKey[2] === workspaceId &&
        (query.queryKey[1] === "sessionInfo" || query.queryKey[1] === "sessionMessages"),
      refetchType: "none",
    })
    void queryClient.invalidateQueries({
      predicate: (query) =>
        (query.queryKey[0] === "chatInputs" || query.queryKey[0] === "chatBackground") &&
        query.queryKey[1] === workspaceId,
    })
    // Invalidation alone deduplicates an initial request without cached data.
    // Cancel it first so a response from before the event cannot win the race.
    void queryClient
      .cancelQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
      .then(() => {
        // Inactive filter/shelf variants cannot display rows known to be
        // uncertain. The displayed list and transcript previews stay cached.
        queryClient.removeQueries({
          queryKey: chatSessionKeys.workspace(workspaceId),
          type: "inactive",
        })
        return queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
      })
  }, [queryClient, watch.data, workspaceId])

  useEffect(() => {
    if (preferences.group_by !== "date" || timeZone === "") return
    const now = new Date()
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
      setDateBoundary(midnight.getTime())
    }, midnight.getTime() - now.getTime())
    return () => window.clearTimeout(timer)
  }, [dateBoundary, preferences.group_by, queryClient, timeZone, workspaceId])

  const updatePreferences = (update: (current: ChatSessionPreference) => ChatSessionPreference) => {
    const previous = queryClient.getQueryData<ChatSessionPreference>(preferenceKey) ?? preferences
    const next = update(previous)
    const key = hashKey(preferenceKey)
    const save = preferenceSaves.current.get(key) ?? { version: 0, value: previous }
    preferenceSaves.current.set(key, save)
    const version = ++save.version
    queryClient.setQueryData(preferenceKey, next)
    mutation.mutate({ next, key: preferenceKey, save, version })
  }
  const rows = sessions.data?.pages.flatMap((page) => page.sessions) ?? []

  const groups = sessions.data?.pages[0]?.groups ?? []
  const participantFilters =
    sessions.data?.pages[0]?.participant_filters ?? initialSessions.participant_filters
  const activeFilterCount =
    (preferences.agent_name ? 1 : 0) +
    preferences.participant_user_ids.length +
    (preferences.include_workflow_runs ? 1 : 0)
  const searchTooShort = searchLength > 0 && searchLength < 3
  const searchTooLong = searchLength > 200
  const searchInvalid = searchTooShort || searchTooLong
  const searchSettling = searchLength >= 3 && searchLength <= 200 && trimmedSearch !== querySearch
  const list = useSessionListMotion(
    rows.map((session) => `${session.agent_name}:${session.session_id}`).join("\0"),
    preferences.group_by === "none" && !sessions.isPending && !searchInvalid && !searchSettling
  )

  const newProjectChat = async (project: CodingProject) => {
    const usable = availableAgents.filter((agent) => agent.capabilities.use)
    const agent =
      usable.find((agent) => agent.name === project.last_agent_name) ??
      usable.find((agent) => agent.name === preferences.last_agent_name) ??
      usable[0]
    const draft = await sessionDrafts.start(draftScope, project.id, agent?.name ?? "")
    try {
      window.localStorage.setItem(
        expansionKey,
        JSON.stringify({ ...projectExpansion, [project.id]: true })
      )
      window.dispatchEvent(new StorageEvent("storage", { key: expansionKey }))
    } catch {
      toast.error("Could not remember expanded projects")
    }
    setPickingProject(false)
    setOpenMobile(false)
    router.push(
      `${workspacePath}/sessions/new?${new URLSearchParams({ project: project.id, draft: draft.id })}`
    )
  }
  const grouping = (
    <DropdownMenuRadioGroup value={preferences.group_by}>
      <DropdownMenuRadioItem
        onSelect={() => updatePreferences((current) => ({ ...current, group_by: "date" }))}
        value="date"
      >
        <CalendarDays aria-hidden="true" />
        Date
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        onSelect={() => updatePreferences((current) => ({ ...current, group_by: "agent" }))}
        value="agent"
      >
        <Bot aria-hidden="true" />
        Agent
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        onSelect={() => updatePreferences((current) => ({ ...current, group_by: "status" }))}
        value="status"
      >
        <Activity aria-hidden="true" />
        State
      </DropdownMenuRadioItem>
      {workspaceType === "coding" ? (
        <DropdownMenuRadioItem
          onSelect={() => updatePreferences((current) => ({ ...current, group_by: "project" }))}
          value="project"
        >
          <FolderGit2 aria-hidden="true" />
          Project
        </DropdownMenuRadioItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuRadioItem
        onSelect={() => updatePreferences((current) => ({ ...current, group_by: "none" }))}
        value="none"
      >
        <Rows3 aria-hidden="true" />
        None
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  )
  const filters = (
    <FieldGroup className="gap-4">
      <Field className="gap-1.5">
        <FieldLabel htmlFor="chat-agent-filter">Agent</FieldLabel>
        <Select
          value={preferences.agent_name ?? allAgentsValue}
          onValueChange={(agentName) =>
            updatePreferences((current) => ({
              ...current,
              agent_name: agentName === allAgentsValue ? null : agentName,
            }))
          }
        >
          <SelectTrigger className="w-full" id="chat-agent-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={allAgentsValue}>
                <Bot />
                All agents
              </SelectItem>
              {availableAgents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  <AgentAvatar appearance={agent.appearance} />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field className="gap-1.5">
        <FieldLabel htmlFor="chat-people-filter">People in chat</FieldLabel>
        <MultiSelectDropdown
          contentClassName="w-(--radix-popover-trigger-width) min-w-0"
          disabled={participantFilters.length === 0}
          emptyMessage="No people found."
          id="chat-people-filter"
          onValueChangeAction={(participantUserIds) =>
            updatePreferences((current) => ({
              ...current,
              participant_user_ids: participantUserIds,
            }))
          }
          options={participantFilters.map((participant) => {
            const label = participant.name || participant.email
            return {
              image: participant.image,
              initials: label.slice(0, 1).toUpperCase(),
              label,
              value: participant.id,
            }
          })}
          placeholder={participantFilters.length === 0 ? "No participants yet" : "All people"}
          searchPlaceholder="Search people..."
          value={preferences.participant_user_ids}
        />
      </Field>
      {workspaceType !== "coding" && (
        <>
          <DropdownMenuSeparator className="-mx-3 w-[calc(100%+1.5rem)]" />
          <Field orientation="horizontal">
            <Switch
              checked={preferences.include_workflow_runs}
              id="chat-workflow-filter"
              onCheckedChange={(checked) =>
                updatePreferences((current) => ({
                  ...current,
                  include_workflow_runs: checked,
                }))
              }
            />
            <FieldLabel htmlFor="chat-workflow-filter">Show workflow run chats</FieldLabel>
          </Field>
        </>
      )}
    </FieldGroup>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-(--sidebar-content-inset) pb-1">
        <Button
          className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground"
          data-tour="new-chat"
          onClick={async (event) => {
            if (projectActions) {
              const available = projects.data ?? (await projects.refetch()).data
              if (!available) {
                toast.error("Could not load projects")
                return
              }
              if (!available.length) {
                projectActions.add()
                return
              }
              if (available.length > 1 && !event.shiftKey) {
                setPickingProject(true)
                return
              }
              let projectId = query.get("project")
              if (event.shiftKey && activeAgentName && activeSessionId) {
                const thread = await getCodingThread({
                  baseUrl: await getGatewayBaseURL(),
                  headers: { "X-AgentZ-Workspace-ID": workspaceId },
                  path: { agentName: activeAgentName, sessionId: activeSessionId },
                })
                if (thread.error) {
                  toast.error("Could not load the active project")
                  return
                }
                projectId = thread.data.worktree.project_id
              }
              const project = available.find((project) => project.id === projectId) ?? available[0]
              if (project) void newProjectChat(project)
              return
            }
            const agent =
              preferences.last_agent_name ?? activeAgentName ?? availableAgents[0]?.name ?? ""
            const draft = await sessionDrafts.start(draftScope, "", agent)
            const search = new URLSearchParams({ draft: draft.id })
            if (agent) search.set("agent", agent)
            const path = `${workspacePath}/sessions/new?${search}` as Route
            if (
              [...document.querySelectorAll("[data-agentz-chat]")].some((chat) =>
                chat.checkVisibility()
              )
            ) {
              window.history.pushState(null, "", path)
              return
            }
            router.push(path, { showProgress: false })
          }}
          size="sm"
          variant="ghost"
        >
          <SquarePen aria-hidden="true" />
          New chat
        </Button>
        {projectActions && preferences.group_by === "project" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add project"
            title="Add project"
            onClick={projectActions.add}
          >
            <FolderGit2 className="size-4" />
          </Button>
        ) : null}
        <Button
          aria-label="Search chats"
          ref={searchTrigger}
          data-tour="search-chats"
          aria-pressed={searchOpen}
          className="size-8 rounded-md border-0 bg-transparent text-sidebar-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground"
          onClick={() => setSearchOpen(true)}
          size="icon-sm"
          variant="ghost"
        >
          <Search aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={
                activeFilterCount === 0
                  ? "Chat list options"
                  : `Chat list options, ${activeFilterCount} active filters`
              }
              className="relative size-8 rounded-md border-0 bg-transparent text-sidebar-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
              size="icon-sm"
              variant="ghost"
            >
              <Settings2 aria-hidden="true" />
              {activeFilterCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-1 -right-1 z-10 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                >
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className={isMobile ? "w-72" : "w-56"}
            side={isMobile ? "bottom" : "right"}
            sideOffset={8}
          >
            {isMobile ? (
              <>
                <DropdownMenuLabel>Group by</DropdownMenuLabel>
                {grouping}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Filters</DropdownMenuLabel>
                <div className="p-2">{filters}</div>
              </>
            ) : (
              <DropdownMenuGroup>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Layers3 aria-hidden="true" className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">Group by</span>
                    <span className="truncate text-muted-foreground capitalize">
                      {preferences.group_by === "status" ? "State" : preferences.group_by}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44" sideOffset={4}>
                    {grouping}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <ListFilter aria-hidden="true" className="text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      Filters
                      {activeFilterCount > 0 ? (
                        <span className="grid h-4 min-w-4 place-items-center rounded bg-foreground/10 px-1 text-[10px] font-medium text-muted-foreground tabular-nums">
                          {activeFilterCount}
                        </span>
                      ) : null}
                    </span>
                    {activeFilterCount === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : null}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    className="max-h-[calc(100dvh-1rem)] w-72 overflow-y-auto p-3"
                    sideOffset={4}
                  >
                    {filters}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuGroup>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {drafts.length > 0 ? (
          <ul
            aria-label="Unsent drafts"
            className="mx-(--sidebar-content-inset) mb-2 flex shrink-0 flex-col gap-0.5 border-b border-sidebar-border pb-2"
          >
            {drafts.map((draft) => (
              <ContextMenu key={draft.id}>
                <ContextMenuTrigger asChild>
                  <li
                    className={cn(
                      "group/draft relative list-none rounded-lg py-0.5 transition-colors",
                      query.get("draft") === draft.id
                        ? "bg-sidebar-accent"
                        : "bg-primary/5 focus-within:bg-primary/10 hover:bg-primary/10 data-[state=open]:bg-primary/10"
                    )}
                  >
                    <Link
                      prefetch={false}
                      aria-label={`Open unsent draft: ${draft.message.text.trim().split("\n", 1)[0] || `${draft.message.files.length} attachment${draft.message.files.length === 1 ? "" : "s"}`}`}
                      aria-current={query.get("draft") === draft.id ? "page" : undefined}
                      className="block h-20 min-w-0 rounded-[inherit] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) pr-8 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset"
                      onClick={(event) => {
                        if (
                          event.button ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return
                        if (
                          ![...document.querySelectorAll("[data-agentz-chat]")].some((chat) =>
                            chat.checkVisibility()
                          )
                        )
                          return
                        event.preventDefault()
                        setOpenMobile(false)
                        window.history.pushState(null, "", event.currentTarget.href)
                      }}
                      href={
                        `${workspacePath}/sessions/new?${new URLSearchParams({ agent: draft.agentName, draft: draft.id, ...(draft.projectId ? { project: draft.projectId } : {}) })}` as Route
                      }
                    >
                      <span className="flex h-5 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
                        <SquarePen aria-hidden className="size-3.5 shrink-0 text-primary" />
                        {draft.agentName ? (
                          <AgentIcon name={draft.agentName} workspaceId={workspaceId} />
                        ) : null}
                        <span className="truncate font-medium">
                          {projects.data?.find((project) => project.id === draft.projectId)?.name ??
                            draft.agentName}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm leading-6 font-medium text-sidebar-foreground/90">
                        {draft.message.text.trim().split("\n", 1)[0] ||
                          `${draft.message.files.length} attachment${draft.message.files.length === 1 ? "" : "s"}`}
                      </span>
                    </Link>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="absolute top-1 right-1 opacity-0 group-focus-within/draft:opacity-100 group-hover/draft:opacity-100 [@media(hover:none)]:opacity-100"
                      aria-label="Discard draft"
                      disabled={Boolean(draft.submission)}
                      onClick={() => discardDraft(draft)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    variant="destructive"
                    disabled={Boolean(draft.submission)}
                    onSelect={() => discardDraft(draft)}
                  >
                    <Trash2 /> Discard draft
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </ul>
        ) : null}
        <AnimatePresence initial={false}>
          {searchOpen ? (
            <ExpandingSearch className="relative px-(--sidebar-content-inset) pb-1">
              <Search
                aria-hidden="true"
                className="absolute top-2 left-[calc(var(--sidebar-content-inset)+0.625rem)] size-4 text-sidebar-muted-foreground"
              />
              <Input
                aria-controls="chat-session-results"
                aria-label="Search chat titles"
                className="h-8 border-sidebar-border bg-sidebar-control-surface pr-8 pl-8"
                onChange={(event) => setSearchText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return
                  setSearchOpen(false)
                  setSearchText("")
                  setSearch("")
                  searchTrigger.current?.focus({ preventScroll: true })
                }}
                placeholder="Search chats"
                ref={searchInput}
                value={searchText}
              />
              <Button
                aria-label="Clear search"
                className="absolute top-0 right-(--sidebar-content-inset) size-8 text-sidebar-muted-foreground hover:text-sidebar-accent-foreground"
                onClick={() => {
                  setSearchOpen(false)
                  setSearchText("")
                  setSearch("")
                  searchTrigger.current?.focus({ preventScroll: true })
                }}
                size="icon-sm"
                variant="ghost"
              >
                <X aria-hidden="true" />
              </Button>
            </ExpandingSearch>
          ) : null}
        </AnimatePresence>

        <div
          aria-busy={
            !searchInvalid && (sessions.isPending || searchSettling || sessions.isFetchingNextPage)
          }
          className="shrink-0 px-(--sidebar-content-inset) pb-2"
          id="chat-session-results"
        >
          {searchTooShort ? (
            <p className="px-2 py-3 text-sm text-sidebar-muted-foreground">
              Type at least 3 characters
            </p>
          ) : null}
          {searchTooLong ? (
            <p className="px-2 py-3 text-sm text-sidebar-muted-foreground">
              Search cannot exceed 200 characters
            </p>
          ) : null}
          {!searchInvalid && (sessions.isPending || searchSettling) ? (
            <SessionListSkeleton
              groupBy={preferences.group_by}
              searching={searchLength >= 3}
              coding={workspaceType === "coding"}
            />
          ) : null}
          {!searchInvalid && !sessions.isPending && !searchSettling && sessions.isError ? (
            <Alert variant="destructive" className="px-1 py-3">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>Could not load chats</AlertDescription>
            </Alert>
          ) : null}
          {!searchInvalid &&
          !sessions.isPending &&
          !searchSettling &&
          preferences.group_by === "none" &&
          rows.length === 0 &&
          drafts.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-sidebar-muted-foreground">
              <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
              No chats found
            </div>
          ) : null}
          <ul ref={list} className="relative flex min-w-0 flex-col gap-0.5">
            {preferences.group_by === "none" && !searchInvalid && !searchSettling
              ? rows.map((session) => (
                  <SessionCard
                    userId={userId}
                    key={`${session.agent_name}:${session.session_id}`}
                    active={
                      path ===
                      `${workspacePath}/agents/${encodeURIComponent(session.agent_name)}/sessions/${encodeURIComponent(session.session_id)}`
                    }
                    session={session}
                    workspaceType={workspaceType}
                    workspaceId={workspaceId}
                    workspacePath={workspacePath}
                  />
                ))
              : null}
            {preferences.group_by === "none" && !searchInvalid && sessions.isFetchingNextPage
              ? Array.from({ length: 2 }, (_, index) => (
                  <SessionCardSkeleton
                    key={`next-session-${index}`}
                    showAgent
                    coding={workspaceType === "coding"}
                  />
                ))
              : null}
          </ul>
          {preferences.group_by === "none" && !searchInvalid && sessions.isFetchingNextPage ? (
            <span className="sr-only" role="status">
              Loading more chats
            </span>
          ) : null}
          {preferences.group_by !== "none" && !searchInvalid && !searchSettling
            ? groups.map((group) => (
                <SessionGroup
                  onNewChat={newProjectChat}
                  projectActions={projectActions}
                  userId={userId}
                  activeAgentName={activeAgentName}
                  activeSessionId={activeSessionId}
                  agentStatus={
                    group.agent_name
                      ? availableAgents.find((agent) => agent.name === group.agent_name)?.status
                      : undefined
                  }
                  group={group}
                  key={group.key}
                  onOpenChange={(open) => {
                    if (querySearch !== "") return
                    if (group.project) {
                      try {
                        window.localStorage.setItem(
                          expansionKey,
                          JSON.stringify({ ...projectExpansion, [group.project.id]: open })
                        )
                        window.dispatchEvent(new StorageEvent("storage", { key: expansionKey }))
                      } catch {
                        toast.error("Could not remember expanded projects")
                      }
                      return
                    }
                    setGroupExpansion((current) => {
                      const next = new Map(current)
                      next.set(`${group.group_by}:${group.key}`, open)
                      return next
                    })
                  }}
                  open={
                    group.project
                      ? (projectExpansion[group.project.id] ??
                        (group.contains_active || query.get("project") === group.project.id))
                      : (groupExpansion.get(`${group.group_by}:${group.key}`) ??
                        group.contains_active)
                  }
                  path={path}
                  preferences={preferences}
                  search={querySearch}
                  timeZone={timeZone}
                  workspaceType={workspaceType}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                />
              ))
            : null}
          {!sessions.isPending &&
          !searchInvalid &&
          !searchSettling &&
          preferences.group_by !== "none" &&
          groups.length === 0 &&
          drafts.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-sidebar-muted-foreground">
              <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
              No chats found
            </div>
          ) : null}
          {preferences.group_by === "none" &&
          !searchInvalid &&
          !searchSettling &&
          sessions.hasNextPage ? (
            <LoadMore
              pending={sessions.isFetchingNextPage}
              className="mt-2 w-full text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground"
              onClick={() => void sessions.fetchNextPage()}
              size="sm"
              variant="ghost"
            >
              <ChevronDown />
              Load more
            </LoadMore>
          ) : null}
        </div>
        <div data-session-shelves className="mt-auto shrink-0 px-(--sidebar-content-inset) pt-2">
          {(["snoozed", "archived"] as const).map((shelf) => (
            <SessionShelf
              key={shelf}
              count={
                (shelf === "snoozed"
                  ? sessions.data?.pages[0]?.snoozed_count
                  : sessions.data?.pages[0]?.archived_count) ?? 0
              }
              shelf={shelf}
              userId={userId}
              preferences={preferences}
              search={querySearch}
              timeZone={timeZone}
              workspaceId={workspaceId}
              workspaceType={workspaceType}
              workspacePath={workspacePath}
              path={path}
            />
          ))}
        </div>
      </div>
      <ProjectPicker
        open={pickingProject}
        onOpenChange={setPickingProject}
        onSelect={newProjectChat}
        projects={projects.data ?? []}
        workspacePath={workspacePath}
      />
    </div>
  )
}

function SessionShelf({
  count,
  shelf,
  userId,
  preferences,
  search,
  timeZone,
  workspaceId,
  workspaceType,
  workspacePath,
  path,
}: Pick<NavSessionsProps, "userId" | "workspaceId" | "workspaceType" | "workspacePath"> & {
  shelf: Exclude<ChatSessionShelf, "active">
  count: number
  preferences: ChatSessionPreference
  search: string
  timeZone: string
  path: string
}) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  const pages = useInfiniteQuery({
    ...chatSessionsOptions(
      workspaceId,
      { ...preferences, group_by: "none" },
      search,
      timeZone,
      undefined,
      undefined,
      userId,
      shelf
    ),
    enabled: open && count > 0,
  })
  const sessions = pages.data?.pages.flatMap((page) => page.sessions) ?? []
  const list = useSessionListMotion(
    sessions.map((session) => `${session.agent_name}:${session.session_id}`).join("\0"),
    open && !pages.isPending,
    "above"
  )
  const label = shelf === "snoozed" ? "Snoozed" : "Archived"
  return (
    <AnimatePresence initial={false}>
      {count > 0 ? (
        <motion.div
          key={shelf}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0, pointerEvents: "none" }}
          transition={{ duration: reduced ? 0 : 0.15, ease: "easeOut" }}
          className="overflow-hidden"
        >
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="flex h-9 w-full items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset">
              <span className="flex-1">{label}</span>
              <span className="font-normal tabular-nums">{count}</span>
              <ChevronDown
                aria-hidden
                className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
              />
            </CollapsibleTrigger>
            <CollapsiblePrimitive.Content
              data-slot="collapsible-content"
              className="overflow-hidden duration-150 motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down"
            >
              {pages.isPending ? (
                <ul aria-label="Loading sessions" className="flex min-w-0 flex-col gap-0.5">
                  {Array.from({ length: Math.min(count, 10) }, (_, index) => (
                    <SessionCardSkeleton key={index} showAgent={false} coding={false} compact />
                  ))}
                </ul>
              ) : null}
              {pages.isError ? (
                <p className="px-2 py-3 text-xs text-destructive">
                  Could not load {label.toLowerCase()}
                </p>
              ) : null}
              {count > 0 && !pages.isFetching && !pages.isError && sessions.length === 0 ? (
                <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
                  No {label.toLowerCase()} chats
                </p>
              ) : null}
              <ul ref={list} className="relative flex min-w-0 flex-col gap-0.5">
                {sessions.map((session) => (
                  <SessionCard
                    userId={userId}
                    key={`${session.agent_name}:${session.session_id}`}
                    active={
                      path ===
                      `${workspacePath}/agents/${encodeURIComponent(session.agent_name)}/sessions/${encodeURIComponent(session.session_id)}`
                    }
                    compact
                    session={session}
                    workspaceId={workspaceId}
                    workspaceType={workspaceType}
                    workspacePath={workspacePath}
                  />
                ))}
              </ul>
              {pages.isPending && count > 10 ? (
                <div aria-hidden className="flex h-7 items-center justify-center">
                  <Skeleton className="h-3 w-16 bg-sidebar-border" />
                </div>
              ) : null}
              {pages.hasNextPage ? (
                <LoadingButton
                  pending={pages.isFetchingNextPage}
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  onClick={() => void pages.fetchNextPage()}
                >
                  Load more
                </LoadingButton>
              ) : null}
            </CollapsiblePrimitive.Content>
          </Collapsible>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function SessionGroup({
  onNewChat,
  projectActions,
  userId,
  activeAgentName,
  activeSessionId,
  agentStatus,
  group,
  onOpenChange,
  open,
  path,
  preferences,
  search,
  timeZone,
  workspaceId,
  workspaceType,
  workspacePath,
}: {
  onNewChat: (project: CodingProject) => Promise<void>
  projectActions?: ProjectActions
  userId: string
  activeAgentName: string | undefined
  activeSessionId: string | undefined
  agentStatus: AgentStatus | undefined
  group: ChatSessionGroup
  onOpenChange: (open: boolean) => void
  open: boolean
  path: string
  preferences: ChatSessionPreference
  search: string
  timeZone: string
  workspaceId: string
  workspaceType: Workspace["type"]
  workspacePath: WorkspacePath
}) {
  const router = useRouter()
  const expanded = open || search !== ""
  const agentName = group.agent_name
  const pages = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: [
        ...chatSessionKeys.group(
          workspaceId,
          preferences,
          group.key,
          search,
          timeZone,
          activeAgentName,
          activeSessionId
        ),
        userId,
      ],
      initialPageParam: undefined,
      queryFn: async ({
        pageParam,
        signal,
      }: {
        pageParam: string | undefined
        signal: AbortSignal
      }) => {
        const result = await listChatSessions({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          query: {
            active_agent_name: activeAgentName,
            active_session_id: activeSessionId,
            agent_name: preferences.agent_name ?? undefined,
            group_by: preferences.group_by,
            group_key: group.key,
            include_filter_options: false,
            include_workflow_runs: preferences.include_workflow_runs,
            limit: pageParam ? 25 : 10,
            page_token: pageParam,
            participant_user_id: preferences.participant_user_ids,
            search: search || undefined,
            time_zone: preferences.group_by === "date" ? timeZone : undefined,
          },
          signal,
        })
        if (result.error) throw result.error
        const [page] = result.data.groups
        if (!page) throw new Error("Gateway omitted the requested chat group")
        return page
      },
      getNextPageParam: (page) => (page.has_next_page ? page.next_page_token : undefined),
      enabled: expanded,
      initialData:
        search !== "" && !group.project ? { pages: [group], pageParams: [undefined] } : undefined,
      staleTime: Infinity,
    })
  )
  const sessions = pages.data?.pages.flatMap((page) => page.sessions) ?? []
  const list = useSessionListMotion(
    sessions.map((session) => `${session.agent_name}:${session.session_id}`).join("\0"),
    expanded && !pages.isPending
  )

  return (
    <Collapsible className="group/chat-group" onOpenChange={onOpenChange} open={expanded}>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!group.project}>
          <div className="relative flex h-8 items-center rounded-md transition-colors hover:bg-sidebar-accent">
            <CollapsibleTrigger asChild>
              <button
                aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label}`}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-sm font-medium text-sidebar-muted-foreground outline-none hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset"
                type="button"
              >
                {group.project ? (
                  <>
                    <GitHubLight aria-hidden="true" className="size-4 shrink-0 dark:hidden" />
                    <GitHubDark aria-hidden="true" className="hidden size-4 shrink-0 dark:block" />
                  </>
                ) : null}
                {group.group_by === "agent" && agentName ? (
                  <AgentBadge status={agentStatus} name={agentName} workspaceId={workspaceId} />
                ) : null}
                {group.group_by === "date" ? (
                  <CalendarDays aria-hidden="true" className="size-4 shrink-0" />
                ) : null}
                {group.status === "busy" ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 shrink-0 text-primary motion-safe:animate-spin"
                  />
                ) : null}
                {group.status === "retry" ? (
                  <RotateCcw aria-hidden="true" className="size-4 shrink-0 text-destructive" />
                ) : null}
                {group.status === "idle" ? (
                  <CirclePause aria-hidden="true" className="size-4 shrink-0 text-primary" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 transition-transform duration-200 group-data-[state=open]/chat-group:rotate-90"
                />
              </button>
            </CollapsibleTrigger>
            {group.project ? (
              <>
                <Button
                  aria-label={`New chat in ${group.label}`}
                  title={`New chat in ${group.label}`}
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0"
                  onClick={() => {
                    if (group.project) void onNewChat(group.project)
                  }}
                >
                  <Plus className="size-3.5" />
                </Button>
              </>
            ) : null}
            {agentName ? (
              <Button
                aria-label={`New chat with ${agentName}`}
                className="mr-1 size-7 shrink-0 text-sidebar-muted-foreground hover:text-sidebar-accent-foreground"
                onClick={() => {
                  const query = new URLSearchParams({ agent: agentName, draft: nanoid() })
                  const path = `${workspacePath}/sessions/new?${query}` as Route
                  if (
                    [...document.querySelectorAll("[data-agentz-chat]")].some((chat) =>
                      chat.checkVisibility()
                    )
                  ) {
                    window.history.pushState(null, "", path)
                    return
                  }
                  router.push(path, { showProgress: false })
                }}
                size="icon-sm"
                variant="ghost"
              >
                <Plus aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </ContextMenuTrigger>
        {group.project ? (
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuItem
                onSelect={() => {
                  if (group.project) projectActions?.manage(group.project, "rename")
                }}
              >
                <Pencil />
                Rename project
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() => {
                  if (group.project) projectActions?.manage(group.project, "delete")
                }}
              >
                <Trash2 />
                Delete project
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
      <CollapsibleContent aria-busy={pages.isPending || pages.isFetchingNextPage}>
        {pages.isPending ? (
          <span className="sr-only" role="status">
            Loading chats in {group.label}
          </span>
        ) : null}
        <SidebarMenuSub
          ref={list}
          className="relative mx-1.5 translate-x-0 gap-0.5 px-1.5 py-0 [&>li]:relative [&>li]:before:absolute [&>li]:before:top-1/2 [&>li]:before:right-full [&>li]:before:w-1.5 [&>li]:before:border-t [&>li]:before:border-sidebar-border [&>li:last-child]:after:absolute [&>li:last-child]:after:top-1/2 [&>li:last-child]:after:right-[calc(100%+0.375rem)] [&>li:last-child]:after:bottom-0 [&>li:last-child]:after:w-px [&>li:last-child]:after:bg-sidebar"
        >
          {pages.isError ? (
            <SidebarMenuSubItem>
              <Alert variant="destructive" className="px-2 py-3">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>Could not load chats</AlertDescription>
              </Alert>
            </SidebarMenuSubItem>
          ) : null}
          {!pages.isPending && !pages.isError && sessions.length === 0 ? (
            <SidebarMenuSubItem>
              <p className="px-2 py-3 text-sm text-sidebar-muted-foreground">
                {search ? "No matching chats" : "No chats yet"}
              </p>
            </SidebarMenuSubItem>
          ) : null}
          {sessions.map((session) => (
            <SessionCard
              userId={userId}
              key={`${session.agent_name}:${session.session_id}`}
              active={
                path ===
                `${workspacePath}/agents/${encodeURIComponent(session.agent_name)}/sessions/${encodeURIComponent(session.session_id)}`
              }
              session={session}
              showAgent={group.group_by !== "agent"}
              workspaceType={workspaceType}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
            />
          ))}
          {pages.isPending
            ? Array.from({ length: 2 }, (_, index) => (
                <SessionCardSkeleton
                  key={`group-session-${index}`}
                  showAgent={group.group_by !== "agent"}
                  coding={workspaceType === "coding"}
                />
              ))
            : null}
          {pages.isFetchingNextPage
            ? Array.from({ length: 2 }, (_, index) => (
                <SessionCardSkeleton
                  key={`next-group-session-${index}`}
                  showAgent={group.group_by !== "agent"}
                  coding={workspaceType === "coding"}
                />
              ))
            : null}
          {pages.hasNextPage ? (
            <SidebarMenuSubItem>
              <LoadingButton
                pending={pages.isFetchingNextPage}
                className="w-full text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground"
                onClick={() => void pages.fetchNextPage()}
                size="sm"
                variant="ghost"
              >
                <ChevronDown data-icon="inline-start" />
                Load more
              </LoadingButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
        {pages.isFetchingNextPage ? (
          <span className="sr-only" role="status">
            Loading more chats in {group.label}
          </span>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

// Measure rows only on order changes and animate native transforms.
function useSessionListMotion(key: string, visible = true, origin: "above" | "below" = "below") {
  const ref = useRef<HTMLUListElement>(null)
  const positions = useRef<Map<
    HTMLLIElement,
    { top: number; left: number; width: number; height: number }
  > | null>(null)
  const running = useRef(
    new Map<HTMLLIElement, { animation: Animation; offset: number; opacity: number }>()
  )
  const exiting = useRef(new Set<HTMLLIElement>())
  const layout = useRef({ top: 0, left: 0, scrollTop: 0 })

  const cancel = useCallback(() => {
    for (const { animation } of running.current.values()) animation.cancel()
    running.current.clear()
    for (const node of exiting.current) node.remove()
    exiting.current.clear()
  }, [])

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = () => {
      if (!media.matches) return
      cancel()
      positions.current = null
    }
    const onResize = () => {
      cancel()
      positions.current = null
    }
    window.addEventListener("resize", onResize)
    media.addEventListener("change", onChange)
    return () => {
      window.removeEventListener("resize", onResize)
      media.removeEventListener("change", onChange)
      cancel()
      positions.current = null
    }
  }, [cancel])

  useLayoutEffect(() => {
    const parent = ref.current
    if (!parent || !visible) {
      cancel()
      positions.current = null
      return
    }
    const next: NonNullable<typeof positions.current> = new Map()
    const offsets = new Map<HTMLLIElement, { offset: number; opacity: number }>()
    for (const [node, previous] of running.current) {
      const progress = previous.animation.effect?.getComputedTiming().progress ?? 0
      offsets.set(node, {
        offset: previous.offset * (1 - progress),
        opacity: previous.opacity + (1 - previous.opacity) * progress,
      })
    }
    // Read all geometry before writing styles, avoiding a reflow for each row.
    for (const node of parent.querySelectorAll<HTMLLIElement>(":scope > li:not([data-exiting])")) {
      next.set(node, {
        top: node.offsetTop,
        left: node.offsetLeft,
        width: node.offsetWidth,
        height: node.offsetHeight,
      })
    }
    const previous = positions.current
    positions.current = next
    let changed = 0
    for (const node of previous?.keys() ?? []) if (!next.has(node)) changed++
    for (const node of next.keys()) if (!previous?.has(node)) changed++
    const animate =
      previous !== null &&
      changed <= 40 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const bounds = parent.getBoundingClientRect()
    const scroller = parent.closest<HTMLElement>(".overflow-y-auto")
    const scrollTop = scroller?.scrollTop ?? 0
    const previousLayout = layout.current
    layout.current = { top: bounds.top, left: bounds.left, scrollTop }
    const top = bounds.top
    const oldTop = previousLayout.top - (scrollTop - previousLayout.scrollTop)
    const height = parent.ownerDocument.documentElement.clientHeight
    // Shelf expansion moves the list without changing its row order.
    const observer = new ResizeObserver(() => {
      if (!parent.isConnected) {
        observer.disconnect()
        return
      }
      const rect = parent.getBoundingClientRect()
      layout.current = { top: rect.top, left: rect.left, scrollTop: scroller?.scrollTop ?? 0 }
    })
    observer.observe(parent.closest("[data-session-shelves]") ?? parent)
    if (!animate) {
      cancel()
      return () => observer.disconnect()
    }
    const timing = { duration: 150, easing: "ease-out" }
    for (const [node, position] of previous) {
      if (next.has(node) || position.height === 0) continue
      if (oldTop + position.top >= height || oldTop + position.top + position.height <= 0) continue
      const current = offsets.get(node)
      const travel = (origin === "above" ? -1 : 1) * Math.min(40, position.height)
      const clone = parent.ownerDocument.importNode(node, true)
      clone.dataset.exiting = ""
      clone.inert = true
      clone.setAttribute("aria-hidden", "true")
      clone.removeAttribute("id")
      for (const child of clone.querySelectorAll("[id]")) {
        if (child.namespaceURI !== "http://www.w3.org/2000/svg") child.removeAttribute("id")
      }
      Object.assign(clone.style, {
        // Exit geometry must survive the source shelf shrinking underneath it.
        position: "fixed",
        top: `${oldTop + position.top + (current?.offset ?? 0)}px`,
        left: `${previousLayout.left + position.left}px`,
        zIndex: "50",
        width: `${position.width}px`,
        height: `${position.height}px`,
        margin: "0",
        pointerEvents: "none",
        transform: "none",
        transition: "none",
      })
      parent.ownerDocument.body.append(clone)
      exiting.current.add(clone)
      const animation = clone.animate(
        [
          { opacity: current?.opacity ?? 1, transform: "translateY(0)" },
          { opacity: 0, transform: `translateY(${travel}px)` },
        ],
        timing
      )
      running.current.get(node)?.animation.cancel()
      running.current.delete(node)
      running.current.set(clone, { animation, offset: 0, opacity: 1 })
      animation.onfinish = () => {
        clone.remove()
        exiting.current.delete(clone)
        running.current.delete(clone)
      }
    }
    for (const [node, position] of next) {
      const old = previous.get(node)
      // Offscreen rows need no animation or compositor layers.
      const start = top + (old?.top ?? position.top)
      const end = top + position.top
      if (Math.min(start, end) >= height || Math.max(start, end) + position.height <= 0) continue
      // Leave an in-flight entry alone when a second update changes another row.
      if (old?.top === position.top && running.current.has(node)) continue
      const offset = old
        ? old.top - position.top + (offsets.get(node)?.offset ?? 0)
        : (origin === "above" ? -1 : 1) * Math.min(40, position.height)
      if ((old && offset === 0) || position.height === 0) continue
      const opacity = offsets.get(node)?.opacity ?? (old ? 1 : 0)
      running.current.get(node)?.animation.cancel()
      const animation = node.animate(
        [
          { transform: `translateY(${offset}px)`, opacity },
          { transform: "translateY(0)", opacity: 1 },
        ],
        timing
      )
      running.current.set(node, { animation, offset, opacity })
      animation.onfinish = () => {
        if (running.current.get(node)?.animation === animation) running.current.delete(node)
      }
    }
    return () => observer.disconnect()
  }, [cancel, key, origin, visible])
  return ref
}

function SessionListSkeleton({
  groupBy,
  searching = false,
  coding,
}: {
  groupBy: ChatSessionGroupBy
  searching?: boolean
  coding: boolean
}) {
  if (groupBy === "none") {
    return (
      <div role="status">
        <span className="sr-only">{searching ? "Searching chats" : "Loading chats"}</span>
        <ul aria-hidden="true" className="flex min-w-0 flex-col gap-0.5">
          {Array.from({ length: 2 }, (_, index) => (
            <SessionCardSkeleton key={`session-${index}`} showAgent coding={coding} />
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div role="status">
      <span className="sr-only">{searching ? "Searching chats" : "Loading chat groups"}</span>
      <div aria-hidden="true">
        {Array.from({ length: searching ? 2 : 3 }, (_, groupIndex) => (
          <div key={`group-${groupIndex}`}>
            <div className="flex h-8 items-center rounded-md">
              <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-(--sidebar-row-content-inset)">
                <Skeleton className="size-4 shrink-0 rounded-sm bg-sidebar-border" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-24 bg-sidebar-border" />
                </div>
                <Skeleton className="size-4 shrink-0 rounded-sm bg-sidebar-border" />
              </div>
              {groupBy === "agent" ? (
                <div className="mr-1 grid size-7 shrink-0 place-items-center">
                  <Skeleton className="size-4 rounded-sm bg-sidebar-border" />
                </div>
              ) : null}
            </div>
            {searching ? (
              <SidebarMenuSub className="mx-1.5 translate-x-0 gap-0.5 px-1.5 py-0 [&>li]:relative [&>li]:before:absolute [&>li]:before:top-1/2 [&>li]:before:right-full [&>li]:before:w-1.5 [&>li]:before:border-t [&>li]:before:border-sidebar-border [&>li:last-child]:after:absolute [&>li:last-child]:after:top-1/2 [&>li:last-child]:after:right-[calc(100%+0.375rem)] [&>li:last-child]:after:bottom-0 [&>li:last-child]:after:w-px [&>li:last-child]:after:bg-sidebar">
                <SessionCardSkeleton showAgent={groupBy !== "agent"} coding={coding} />
              </SidebarMenuSub>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function SessionCardSkeleton({
  showAgent,
  coding,
  compact = false,
}: {
  showAgent: boolean
  coding: boolean
  compact?: boolean
}) {
  if (compact)
    return (
      <li
        aria-hidden
        className="flex h-10 min-w-0 list-none items-center gap-2 px-(--sidebar-row-content-inset)"
      >
        <Skeleton className="size-4 shrink-0 rounded-sm bg-sidebar-border" />
        <div className="flex h-5 min-w-0 flex-1 items-center">
          <Skeleton className="h-3 w-4/5 bg-sidebar-border" />
        </div>
        <Skeleton className="h-3 w-5 shrink-0 bg-sidebar-border" />
      </li>
    )
  return (
    <li aria-hidden="true" className="list-none rounded-lg py-0.5">
      <div
        className={cn(
          "px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
          coding ? "h-20" : "h-16"
        )}
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          {showAgent ? <Skeleton className="size-4 shrink-0 rounded-sm bg-sidebar-border" /> : null}
          <div className="min-w-0 flex-1">
            {showAgent ? <Skeleton className="h-3 w-16 bg-sidebar-border" /> : null}
          </div>
          <Skeleton className="h-3 w-5 shrink-0 bg-sidebar-border" />
        </div>
        <div className={cn("mt-1 flex min-w-0 items-center gap-2", coding ? "h-5" : "h-6")}>
          <Skeleton className="h-3.5 w-4/5 bg-sidebar-border" />
        </div>
        {coding ? (
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="h-3 w-2/3 bg-sidebar-border" />
            <Skeleton className="ml-auto h-3 w-[7ch] bg-sidebar-border" />
          </div>
        ) : null}
      </div>
    </li>
  )
}

function AgentBadge({
  status,
  name,
  workspaceId,
}: {
  status: AgentStatus | undefined
  name: string
  workspaceId: string
}) {
  if (status && agentIsGettingReady(status)) {
    return (
      <span className={status === "DEGRADED" ? "shrink-0 text-destructive" : "shrink-0"}>
        <Spinner aria-label="Getting ready" className="size-3" />
      </span>
    )
  }
  return (
    <span
      aria-label={status === "IDLE" ? "Idle" : "Unavailable"}
      className={cn("shrink-0", status !== "IDLE" && "opacity-50")}
      role="status"
    >
      <AgentIcon name={name} workspaceId={workspaceId} />
    </span>
  )
}

function SessionCheckout({ session, workspaceId }: { session: ChatSession; workspaceId: string }) {
  const { data: actor } = authClient.useSession()
  const { data: thread, isPending: threadPending } = useQuery(
    codingThreadOptions(workspaceId, session.agent_name, session.session_id)
  )
  const gitStatus = useQuery({
    ...codingGitOptions(workspaceId, thread?.worktree.id, actor?.user.id),
    enabled: false,
  })
  const {
    data: diff,
    isPending: diffPending,
    refetch: refetchDiff,
  } = useQuery(sessionDiffQueryOptions(session.agent_name, workspaceId, session.session_id))

  useEffect(() => {
    void refetchDiff()
  }, [refetchDiff, session.status, session.updated_at])

  const worktree = thread?.worktree
  const branch = gitStatus.data?.branch ?? worktree?.branch

  return (
    <div className="flex h-5 min-w-0 items-center gap-2 text-xs">
      <div className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">
        {threadPending ? (
          <Skeleton
            aria-label="Loading branch"
            className="h-3 w-2/3 bg-sidebar-border motion-reduce:animate-none"
            role="status"
          />
        ) : (
          branch || worktree?.directory.split("/").at(-1)
        )}
      </div>
      {diffPending ? (
        <Skeleton
          aria-label="Loading diff stats"
          className="h-3 w-[7ch] shrink-0 bg-sidebar-border motion-reduce:animate-none"
          role="status"
        />
      ) : diff ? (
        <span
          aria-label={`Latest turn: ${diff.additions} lines added, ${diff.deletions} lines removed`}
          className="shrink-0 font-mono"
          role="img"
        >
          <span className="text-emerald-600 dark:text-emerald-400">+{diff.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
        </span>
      ) : null}
    </div>
  )
}

function SessionStatus({
  session,
  workspaceId,
  userId,
}: {
  session: ChatSession
  workspaceId: string
  userId: string
}) {
  const wokeAt = session.woke_at
  const storageKey = JSON.stringify([
    "chat-wake",
    userId,
    workspaceId,
    session.agent_name,
    session.session_id,
  ])
  const [dismissed, setDismissed] = useState(false)
  const savedWake = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!wokeAt) return () => {}
        const onStorage = (event: StorageEvent) => {
          if (event.key === storageKey || event.key === null) listener()
        }
        window.addEventListener("storage", onStorage)
        return () => window.removeEventListener("storage", onStorage)
      },
      [storageKey, wokeAt]
    ),
    () => {
      if (!wokeAt) return null
      try {
        return window.localStorage.getItem(storageKey)
      } catch {
        return null
      }
    },
    () => wokeAt ?? null
  )
  const woke = wokeAt && !dismissed && savedWake !== wokeAt

  return session.snoozed_until ? (
    <span
      className="inline-flex items-center gap-1"
      title={`Wakes ${dayjs(session.snoozed_until).format("MMM D, h:mm A")}`}
    >
      <AlarmClock className="size-3" aria-hidden="true" />
      {dayjs(session.snoozed_until).format("MMM D, HH:mm")}
    </span>
  ) : session.status === "idle" && !session.archived && woke ? (
    <button
      type="button"
      aria-label="Dismiss Woke notification"
      className="pointer-events-auto relative inline-flex items-center gap-1 rounded-sm font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      title={`Woke from snooze ${dayjs(wokeAt).format("MMM D, h:mm A")}`}
      onClick={(event) => {
        event.stopPropagation()
        if (!wokeAt) return
        try {
          // A new wake timestamp must remain visible after an earlier dismissal.
          window.localStorage.setItem(storageKey, wokeAt)
          window.dispatchEvent(new StorageEvent("storage", { key: storageKey }))
        } catch {
          setDismissed(true)
        }
      }}
    >
      <AlarmClock aria-hidden="true" className="size-3" />
      <span role="status">Woke</span>
    </button>
  ) : session.status === "idle" ? (
    formatShortAge(new Date(session.updated_at).getTime())
  ) : (
    <span className="flex items-center gap-1 font-medium text-info" role="status">
      <LoaderCircle aria-hidden="true" className="size-3 motion-safe:animate-spin" />
      Working
    </span>
  )
}

function SessionCardView({
  active,
  userId,
  compact = false,
  session,
  showAgent = true,
  workspaceId,
  workspaceType,
  workspacePath,
}: {
  active: boolean
  userId: string
  compact?: boolean
  session: ChatSession
  showAgent?: boolean
  workspaceId: string
  workspaceType: Workspace["type"]
  workspacePath: WorkspacePath
}) {
  const coding = workspaceType === "coding"
  const href =
    `${workspacePath}/agents/${encodeURIComponent(session.agent_name)}/sessions/${encodeURIComponent(session.session_id)}` as Route
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const queryClient = useQueryClient()
  const [pendingState, action, isPending] = useActionState<DeleteSessionFormState, FormData>(
    async (state, formData) => {
      const result = await deleteAgentSessionAction(
        session.agent_name,
        workspaceId,
        state,
        formData
      )
      if (!result.success) return result

      await removeSessionState(queryClient, session.agent_name, workspaceId, session.session_id)
      await removeChatSessionFromCache(queryClient, workspaceId, session)
      const channel = new BroadcastChannel(`chatSessionDeletion:${workspaceId}`)
      channel.postMessage({
        agent_name: session.agent_name,
        session_id: session.session_id,
        source: chatDeletionSource,
      } satisfies Pick<ChatSession, "agent_name" | "session_id"> & { source: string })
      channel.close()
      toast.success("Chat deleted")
      setConfirmingDelete(false)

      void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
      return result
    },
    { success: false }
  )

  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(session.title)
  const renameCancelled = useRef(false)
  const renameRequested = useRef(false)
  const [snoozeTimes, setSnoozeTimes] = useState<{ label: string; at: Date }[]>([])
  const edit = useMutation({
    mutationFn: async (change: UpdateChatSessionRequest | { title: string }) => {
      if ("title" in change) {
        const client = await createAgentOpencodeClient(session.agent_name, workspaceId)
        const result = await client.session.update({
          sessionID: session.session_id,
          title: change.title,
        })
        if (result.error) throw result.error
        return
      }
      const result = await updateChatSession({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName: session.agent_name, sessionId: session.session_id },
        body: change,
      })
      if (result.error) throw result.error
    },
    onSuccess: async (_, change) => {
      setRenaming(false)
      // SSE may already have populated the destination before this acknowledgement.
      if ("shelf" in change)
        await removeChatSessionFromCache(queryClient, workspaceId, session, change.shelf)
      void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
      void queryClient.invalidateQueries({
        queryKey: sessionInfoQueryOptions(session.agent_name, workspaceId, session.session_id)
          .queryKey,
      })
    },
    onError: () => toast.error("Could not update chat. Try again."),
  })
  const snoozed = session.snoozed_until !== undefined
  const sessionTitle = renaming ? (
    <Input
      autoFocus
      aria-label="Thread title"
      value={title}
      maxLength={200}
      disabled={edit.isPending}
      dir="auto"
      className="pointer-events-auto relative h-5 min-w-0 flex-1 rounded-sm px-1 py-0 text-sm font-medium shadow-none focus-visible:ring-0"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setTitle(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing) return
        if (event.key === "Escape") {
          event.preventDefault()
          renameCancelled.current = true
          setRenaming(false)
        }
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
      onBlur={() => {
        if (renameCancelled.current) return
        setRenaming(false)
        const next = title.trim()
        if (next && next !== session.title) edit.mutate({ title: next })
      }}
    />
  ) : (
    <span data-session-title className="session-title block truncate" title={session.title}>
      {session.title}
    </span>
  )

  const { setOpenMobile } = useSidebar()
  const status = (
    <SessionStatus
      key={session.woke_at}
      session={session}
      workspaceId={workspaceId}
      userId={userId}
    />
  )
  const avatars =
    session.participants.length > 0 ? (
      <PresenceAvatars
        label="Chat participants"
        max={3}
        size={coding ? 20 : 24}
        overlap={7}
        people={session.participants.map((participant) => ({
          id: participant.id,
          name: participant.name || participant.email || participant.id,
          src: participant.image ?? undefined,
        }))}
      />
    ) : null

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) return
        const now = new Date()
        const evening = new Date(now)
        evening.setHours(18, 0, 0, 0)
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        setSnoozeTimes(
          [
            { label: "In 1 hour", at: new Date(now.getTime() + 3600000) },
            { label: "In 3 hours", at: new Date(now.getTime() + 10800000) },
            { label: "This evening", at: evening },
            { label: "Tomorrow", at: tomorrow },
          ].filter((choice) => choice.at > now)
        )
      }}
    >
      <ContextMenuTrigger asChild>
        <li
          className={cn(
            "group/session relative list-none rounded-lg text-sidebar-muted-foreground transition-colors focus-within:bg-sidebar-accent focus-within:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
            !compact && "py-0.5",
            compact &&
              session.archived &&
              !active &&
              "[&_[data-mascot]]:opacity-50 [&_[data-mascot]]:grayscale hover:[&_[data-mascot]]:opacity-100 hover:[&_[data-mascot]]:grayscale-0",
            active && "bg-sidebar-accent text-sidebar-accent-foreground"
          )}
        >
          <Link
            prefetch={false}
            onPointerEnter={(event) => {
              const row = event.currentTarget.parentElement
              const title = row?.querySelector<HTMLElement>("[data-session-title]")
              if (title) {
                const overflow = title.scrollWidth - title.clientWidth
                title.style.setProperty("--title-travel", `${Math.max(0, overflow)}px`)
                title.style.setProperty("--title-duration", `${Math.max(0.6, overflow / 50)}s`)
                title.dataset.overflow = String(overflow > 0)
              }

              void queryClient
                .fetchQuery(
                  sessionInfoQueryOptions(session.agent_name, workspaceId, session.session_id)
                )
                .then((info) => {
                  if (!info) return
                  return queryClient.prefetchInfiniteQuery(
                    sessionMessagesQueryOptions(
                      session.agent_name,
                      workspaceId,
                      session.session_id,
                      info.directory
                    )
                  )
                })
                .catch(() => {
                  /* Opening the chat owns visible errors. */
                })
            }}
            onClick={(event) => {
              setOpenMobile(false)
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              if (
                ![...document.querySelectorAll("[data-agentz-chat]")].some((chat) =>
                  chat.checkVisibility()
                )
              )
                return
              event.preventDefault()
              // The chat shell follows the URL; session APIs still authorize
              // every read. Switching chats need not round-trip through RSC.
              window.history.pushState(null, "", href)
            }}
            title={session.title}
            aria-label={`Open ${session.title}`}
            aria-current={active ? "page" : undefined}
            className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset"
            href={href}
          />
          {compact ? (
            <div className="pointer-events-none relative flex h-10 min-w-0 items-center gap-2 px-(--sidebar-row-content-inset)">
              <AgentIcon name={session.agent_name} workspaceId={workspaceId} />
              <span
                className={cn(
                  "min-w-0 flex-1 overflow-hidden text-sm font-medium",
                  !active && "text-sidebar-muted-foreground"
                )}
              >
                {sessionTitle}
              </span>
              <span className="shrink-0 text-xs text-sidebar-muted-foreground tabular-nums group-focus-within/session:hidden group-hover/session:hidden [@media(hover:none)]:hidden">
                {status}
              </span>
              <Button
                aria-label={session.archived ? "Unarchive" : "Wake now"}
                className="pointer-events-auto hidden group-focus-within/session:inline-flex group-hover/session:inline-flex [@media(hover:none)]:inline-flex"
                disabled={edit.isPending}
                size="icon-sm"
                variant="ghost"
                onClick={() => edit.mutate({ shelf: "active" })}
              >
                {session.archived ? <ArchiveRestore /> : <AlarmClockOff />}
              </Button>
            </div>
          ) : (
            <div
              className={cn(
                "pointer-events-none relative px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
                coding ? "h-20" : "h-16"
              )}
            >
              <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
                {showAgent ? (
                  <AgentIcon name={session.agent_name} workspaceId={workspaceId} />
                ) : null}
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {showAgent ? session.agent_name : null}
                </span>
                <span className="shrink-0 tabular-nums">{status}</span>
              </div>
              <div className={cn("mt-1 flex min-w-0 items-center gap-2", coding ? "h-5" : "h-6")}>
                <h3
                  className={cn(
                    "min-w-0 flex-1 overflow-hidden text-sm leading-5 font-semibold text-sidebar-foreground/80",
                    active && "text-sidebar-foreground",
                    session.archived && !active && "font-normal text-sidebar-muted-foreground"
                  )}
                >
                  {sessionTitle}
                </h3>
                {avatars}
              </div>
              {coding ? <SessionCheckout session={session} workspaceId={workspaceId} /> : null}
            </div>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (!renameRequested.current) return
          event.preventDefault()
          renameRequested.current = false
          setRenaming(true)
        }}
      >
        <ContextMenuGroup>
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(session.session_id).then(
                () => toast.success("Session ID copied"),
                () => toast.error("Could not copy session ID")
              )
            }}
          >
            <Copy />
            Copy session ID
          </ContextMenuItem>
          <ContextMenuItem
            disabled={edit.isPending}
            onSelect={() => {
              renameCancelled.current = false
              renameRequested.current = true
              setTitle(session.title)
            }}
          >
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            disabled={edit.isPending}
            onSelect={() => edit.mutate({ shelf: session.archived ? "active" : "archived" })}
          >
            {session.archived ? <ArchiveRestore /> : <Archive />}
            {session.archived ? "Unarchive" : "Archive"}
          </ContextMenuItem>
          {snoozed ? (
            <ContextMenuItem
              disabled={edit.isPending}
              onSelect={() => edit.mutate({ shelf: "active" })}
            >
              <AlarmClockOff />
              Wake now
            </ContextMenuItem>
          ) : !session.archived ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={edit.isPending}>
                <AlarmClock />
                Snooze
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuGroup>
                  {snoozeTimes.map((choice) => (
                    <ContextMenuItem
                      key={choice.label}
                      onSelect={() =>
                        edit.mutate({ shelf: "snoozed", snoozed_until: choice.at.toISOString() })
                      }
                    >
                      {choice.label} (
                      {choice.at.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      )
                    </ContextMenuItem>
                  ))}
                </ContextMenuGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          <ContextMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
            <Trash2 />
            Delete chat
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              Deleting <span className="font-medium">{session.title}</span> cannot be undone.
              {session.pulse
                ? " Automatic follow-ups, linked schedules, and their active runs will stop."
                : null}
            </DialogDescription>
          </DialogHeader>
          {pendingState.error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{pendingState.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={isPending} variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <input name="sessionID" type="hidden" value={session.session_id} />
              <LoadingButton
                pending={isPending}
                pendingLabel="Deleting..."
                type="submit"
                variant="destructive"
              >
                <Trash2 />
                Delete
              </LoadingButton>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ContextMenu>
  )
}

// Moving an array entry must not re-render every unchanged keyed card.
const SessionCard = memo(
  SessionCardView,
  (previous, next) => replaceEqualDeep(previous, next) === previous
)

function chatSessionWatchOptions(workspaceId: string, userId: string) {
  return queryOptions({
    queryKey: ["watchChatSessions", workspaceId, userId],
    queryFn: streamedQuery<WatchChatSessionsEvent, number, ["watchChatSessions", string, string]>({
      initialValue: 0,
      refetchMode: "append",
      reducer: (revision) => revision + 1,
      streamFn: async function* ({ signal, client }) {
        const result = await watchChatSessions({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
        })
        for await (const event of result.stream) {
          if (event.revision === "0") {
            void client.invalidateQueries({
              queryKey: watchAgentsQueryOptions(workspaceId).queryKey,
            })
          }
          yield event
        }
        if (!signal.aborted) throw new Error("Chat session watch closed")
      },
    }),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })
}
