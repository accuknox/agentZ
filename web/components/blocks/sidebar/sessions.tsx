"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { GitHubDark, GitHubLight } from "@ridemountainpig/svgl-react"
import {
  experimental_streamedQuery as streamedQuery,
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import {
  Activity,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CirclePause,
  FolderGit2,
  Ellipsis,
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
} from "lucide-react"
import { nanoid } from "nanoid"
import { useActionState, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Projects, ProjectPicker, type ProjectActions } from "@/components/blocks/coding/projects"
import { authClient } from "@/lib/auth-client"
import { codingGitOptions, codingThreadOptions } from "@/lib/coding/review"
import { codingDrafts } from "@/components/blocks/coding/drafts"

import { deleteAgentSessionAction } from "@/data/opencode.actions"
import type { DeleteSessionFormState, ListAgentActionResponse, WorkspacePath } from "@/data/types"
import { agentIsGettingReady, watchAgentsQueryOptions } from "@/components/agent-readiness"
import { AgentWorkingIndicator } from "@/components/agent-working-indicator"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogAlert,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AlertDescription } from "@/components/ui/alert"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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
import { UserAvatar } from "@/components/ui/avatar"
import { sessionDiffQueryOptions } from "@/components/blocks/chat/use-opencode-chat"
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
import { formatShortAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { cn } from "@/lib/utils"
import {
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
  previous: ChatSessionPreference
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

const chatSessionKeys = {
  preference: (workspaceId: string) => ["chatSessionPreference", workspaceId] as const,
  workspace: (workspaceId: string) => ["chatSessions", workspaceId] as const,
  list: (
    workspaceId: string,
    preferences: ChatSessionPreference,
    search: string,
    timeZone: string,
    activeAgentName: string | undefined,
    activeSessionId: string | undefined
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
      activeAgentName,
      activeSessionId,
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
  userId: string
) {
  return infiniteQueryOptions({
    queryKey: [
      ...chatSessionKeys.list(
        workspaceId,
        preferences,
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
          agent_name: preferences.agent_name ?? undefined,
          include_workflow_runs: preferences.include_workflow_runs,
          group_by: preferences.group_by,
          search: search || undefined,
          time_zone: preferences.group_by === "date" ? timeZone : undefined,
          active_agent_name: activeAgentName,
          active_session_id: activeSessionId,
          limit: pageParam ? 25 : 10,
          include_filter_options: pageParam === undefined,
          page_token: pageParam,
          participant_user_id: preferences.participant_user_ids,
        },
        signal,
      })
      if (result.error) throw result.error
      return result.data
    },
    getNextPageParam: (page) => (page.has_next_page ? page.next_page_token : undefined),
    staleTime: Infinity,
  })
}

async function removeChatSessionFromCache(
  queryClient: QueryClient,
  workspaceId: string,
  session: Pick<ChatSession, "agent_name" | "session_id">
) {
  const queryKey = chatSessionKeys.workspace(workspaceId)
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueriesData<InfiniteData<ListChatSessionsResponse>>(
    { queryKey, predicate: (query) => query.queryKey[2] === "list" },
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
    { queryKey, predicate: (query) => query.queryKey[2] === "group" },
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
  const { isMobile, state } = useSidebar()
  if (!isMobile && state === "collapsed") return null

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
    <div className="flex min-h-0 flex-1 flex-col" data-tour="loading-chats">
      <div
        aria-hidden="true"
        className="flex h-9 items-center gap-1 px-[var(--sidebar-content-inset)] pb-1"
      >
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2">
          <Skeleton className="bg-sidebar-border size-4 shrink-0 rounded-sm" />
          <Skeleton className="bg-sidebar-border h-4 w-20" />
        </div>
        <div className="grid size-8 shrink-0 place-items-center">
          <Skeleton className="bg-sidebar-border size-4 rounded-sm" />
        </div>
        <div className="grid size-8 shrink-0 place-items-center">
          <Skeleton className="bg-sidebar-border size-4 rounded-sm" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-[var(--sidebar-content-inset)] pb-2">
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
  const [pickingProject, setPickingProject] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState("")
  const [search, setSearch] = useState("")
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [dateBoundary, setDateBoundary] = useState(0)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
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
  const preferenceKey = [...chatSessionKeys.preference(workspaceId), userId]
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
  const sessions = useInfiniteQuery({
    ...chatSessionsOptions(
      workspaceId,
      preferences,
      querySearch,
      timeZone,
      activeAgentName,
      activeSessionId,
      userId
    ),
    enabled:
      trimmedSearch === querySearch &&
      (searchLength === 0 || (searchLength >= 3 && searchLength <= 200)) &&
      (preferences.group_by !== "date" || timeZone !== ""),
    initialData:
      path === initialPath &&
      matchesInitialPreferences &&
      querySearch === "" &&
      preferences.group_by !== "date" &&
      activeAgentName === undefined &&
      activeSessionId === undefined
        ? { pages: [initialSessions], pageParams: [undefined] }
        : undefined,
  })
  const mutation = useMutation({
    scope: { id: `chat-preferences:${workspaceId}` },
    mutationFn: async ({ next }: PreferenceMutation) => {
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
      toast.error("Could not save chat filters")
    },
    onSuccess: (saved, { next }) => {
      if (queryClient.getQueryData(preferenceKey) !== next) return
      queryClient.setQueryData(preferenceKey, saved)
    },
  })
  useEffect(() => {
    const channel = new BroadcastChannel(`chatSessionDeletion:${workspaceId}`)
    channel.onmessage = (event: MessageEvent<Pick<ChatSession, "agent_name" | "session_id">>) => {
      void removeChatSessionFromCache(queryClient, workspaceId, event.data)
    }
    return () => channel.close()
  }, [queryClient, workspaceId])

  const watch = useQuery(chatSessionWatchOptions(workspaceId, userId))

  useEffect(() => {
    if (!watch.data) return
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === "chatInputs" && query.queryKey[1] === workspaceId,
    })
    void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
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
    queryClient.setQueryData(preferenceKey, next)
    mutation.mutate({ next, previous })
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

  const newProjectChat = async (project: CodingProject) => {
    const usable = availableAgents.filter((agent) => agent.capabilities.use)
    const agent =
      usable.find((agent) => agent.name === project.last_agent_name) ??
      usable.find((agent) => agent.name === preferences.last_agent_name) ??
      usable[0]
    const draft = await codingDrafts.start(draftScope, project.id, agent?.name ?? "")
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
                  <Bot />
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
            <Checkbox
              checked={preferences.include_workflow_runs}
              id="chat-workflow-filter"
              onCheckedChange={(checked) =>
                updatePreferences((current) => ({
                  ...current,
                  include_workflow_runs: checked === true,
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
      <div className="flex items-center gap-1 px-[var(--sidebar-content-inset)] pb-1">
        <Button
          className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground h-8 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 text-sm font-medium shadow-none"
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
            const path = `${workspacePath}/sessions/new?draft=${nanoid()}`
            window.history.pushState(null, "", path)
            router.refresh({ showProgress: false })
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
          data-tour="search-chats"
          aria-pressed={searchOpen}
          className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground size-8 rounded-md border-0 bg-transparent shadow-none"
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
              className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground relative size-8 rounded-md border-0 bg-transparent shadow-none"
              size="icon-sm"
              variant="ghost"
            >
              <Settings2 aria-hidden="true" />
              {activeFilterCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="bg-primary text-primary-foreground pointer-events-none absolute -top-1 -right-1 z-10 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold"
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
                    <span className="text-muted-foreground truncate capitalize">
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
                        <span className="bg-foreground/10 text-muted-foreground grid h-4 min-w-4 place-items-center rounded px-1 text-[10px] font-medium tabular-nums">
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

      {searchOpen ? (
        <div className="relative px-[var(--sidebar-content-inset)] pb-1">
          <Search
            aria-hidden="true"
            className="text-sidebar-muted-foreground absolute top-2 left-[calc(var(--sidebar-content-inset)+0.625rem)] size-4"
          />
          <Input
            aria-controls="chat-session-results"
            aria-label="Search chat titles"
            className="border-sidebar-border bg-sidebar-control-surface h-8 pr-8 pl-8"
            onChange={(event) => setSearchText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              setSearchOpen(false)
              setSearchText("")
              setSearch("")
            }}
            placeholder="Search chats"
            ref={searchInput}
            value={searchText}
          />
          <Button
            aria-label="Clear search"
            className="text-sidebar-muted-foreground hover:text-sidebar-accent-foreground absolute top-0 right-[var(--sidebar-content-inset)] size-8"
            onClick={() => {
              setSearchOpen(false)
              setSearchText("")
              setSearch("")
            }}
            size="icon-sm"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div
        aria-busy={
          !searchInvalid && (sessions.isPending || searchSettling || sessions.isFetchingNextPage)
        }
        className="min-h-0 flex-1 overflow-y-auto px-[var(--sidebar-content-inset)] pb-2"
        id="chat-session-results"
      >
        {searchTooShort ? (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-sm">
            Type at least 3 characters
          </p>
        ) : null}
        {searchTooLong ? (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-sm">
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
          <p className="text-destructive px-1 py-3 text-sm">Could not load chats</p>
        ) : null}
        {!searchInvalid &&
        !sessions.isPending &&
        !searchSettling &&
        preferences.group_by === "none" &&
        rows.length === 0 ? (
          <div className="text-sidebar-muted-foreground px-2 py-8 text-center text-sm">
            <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
            No chats found
          </div>
        ) : null}
        <ul className="flex min-w-0 flex-col gap-0.5">
          {preferences.group_by === "none" && !searchInvalid && !searchSettling
            ? rows.map((session) => (
                <SessionCard
                  key={`${session.agent_name}:${session.session_id}`}
                  path={path}
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
                  setOpenGroups((current) => {
                    const next = new Set(current)
                    if (open) next.add(group.key)
                    else next.delete(group.key)
                    return next
                  })
                }}
                open={
                  group.project
                    ? (projectExpansion[group.project.id] ??
                      (group.contains_active || query.get("project") === group.project.id))
                    : openGroups.has(group.key) || group.contains_active
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
        groups.length === 0 ? (
          <div className="text-sidebar-muted-foreground px-2 py-8 text-center text-sm">
            <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
            No chats found
          </div>
        ) : null}
        {preferences.group_by === "none" &&
        !searchInvalid &&
        !searchSettling &&
        sessions.hasNextPage ? (
          <Button
            className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground mt-2 w-full"
            disabled={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
            size="sm"
            variant="ghost"
          >
            {sessions.isFetchingNextPage ? <Spinner /> : <ChevronDown />}
            Load more
          </Button>
        ) : null}
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

  return (
    <Collapsible className="group/chat-group" onOpenChange={onOpenChange} open={expanded}>
      <div className="hover:bg-sidebar-accent relative flex h-8 items-center rounded-md transition-colors">
        <CollapsibleTrigger asChild>
          <button
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label}`}
            className="focus-visible:ring-sidebar-ring text-sidebar-muted-foreground hover:text-sidebar-accent-foreground flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
            type="button"
          >
            {group.project ? (
              <>
                <GitHubLight aria-hidden="true" className="size-4 shrink-0 dark:hidden" />
                <GitHubDark aria-hidden="true" className="hidden size-4 shrink-0 dark:block" />
              </>
            ) : null}
            {group.group_by === "agent" ? <AgentBadge status={agentStatus} /> : null}
            {group.group_by === "date" ? (
              <CalendarDays aria-hidden="true" className="size-4 shrink-0" />
            ) : null}
            {group.status === "busy" ? (
              <LoaderCircle
                aria-hidden="true"
                className="text-primary size-4 shrink-0 motion-safe:animate-spin"
              />
            ) : null}
            {group.status === "retry" ? (
              <RotateCcw aria-hidden="true" className="text-destructive size-4 shrink-0" />
            ) : null}
            {group.status === "idle" ? (
              <CirclePause aria-hidden="true" className="text-primary size-4 shrink-0" />
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Options for ${group.label}`}
                  variant="ghost"
                  size="icon-sm"
                  className="mr-1 size-7 shrink-0"
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem
                  onSelect={() => {
                    if (group.project) projectActions?.manage(group.project, "rename")
                  }}
                >
                  <Pencil />
                  Rename project
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    if (group.project) projectActions?.manage(group.project, "delete")
                  }}
                >
                  <Trash2 />
                  Delete project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
        {agentName ? (
          <Button
            aria-label={`New chat with ${agentName}`}
            className="text-sidebar-muted-foreground hover:text-sidebar-accent-foreground mr-1 size-7 shrink-0"
            onClick={() => {
              const query = new URLSearchParams({ agent: agentName, draft: nanoid() })
              window.history.pushState(null, "", `${workspacePath}/sessions/new?${query}`)
              router.refresh({ showProgress: false })
            }}
            size="icon-sm"
            variant="ghost"
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <CollapsibleContent aria-busy={pages.isPending || pages.isFetchingNextPage}>
        {pages.isPending ? (
          <span className="sr-only" role="status">
            Loading chats in {group.label}
          </span>
        ) : null}
        <SidebarMenuSub className="[&>li]:before:border-sidebar-border [&>li:last-child]:after:bg-sidebar mx-1.5 translate-x-0 gap-0.5 px-1.5 py-0 [&>li]:relative [&>li]:before:absolute [&>li]:before:top-1/2 [&>li]:before:right-full [&>li]:before:w-1.5 [&>li]:before:border-t [&>li:last-child]:after:absolute [&>li:last-child]:after:top-1/2 [&>li:last-child]:after:right-[calc(100%+0.375rem)] [&>li:last-child]:after:bottom-0 [&>li:last-child]:after:w-px">
          {pages.isError ? (
            <SidebarMenuSubItem>
              <p className="text-destructive px-2 py-3 text-sm">Could not load chats</p>
            </SidebarMenuSubItem>
          ) : null}
          {!pages.isPending && !pages.isError && sessions.length === 0 ? (
            <SidebarMenuSubItem>
              <p className="text-sidebar-muted-foreground px-2 py-3 text-sm">
                {search ? "No matching chats" : "No chats yet"}
              </p>
            </SidebarMenuSubItem>
          ) : null}
          {sessions.map((session) => (
            <SessionCard
              key={`${session.agent_name}:${session.session_id}`}
              path={path}
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
              <Button
                className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground w-full"
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
                size="sm"
                variant="ghost"
              >
                {pages.isFetchingNextPage ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ChevronDown data-icon="inline-start" />
                )}
                Load more
              </Button>
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
              <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-[var(--sidebar-row-content-inset)]">
                <Skeleton className="bg-sidebar-border size-4 shrink-0 rounded-sm" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="bg-sidebar-border h-4 w-24" />
                </div>
                <Skeleton className="bg-sidebar-border size-4 shrink-0 rounded-sm" />
              </div>
              {groupBy === "agent" ? (
                <div className="mr-1 grid size-7 shrink-0 place-items-center">
                  <Skeleton className="bg-sidebar-border size-4 rounded-sm" />
                </div>
              ) : null}
            </div>
            {searching ? (
              <SidebarMenuSub className="[&>li]:before:border-sidebar-border [&>li:last-child]:after:bg-sidebar mx-1.5 translate-x-0 gap-0.5 px-1.5 py-0 [&>li]:relative [&>li]:before:absolute [&>li]:before:top-1/2 [&>li]:before:right-full [&>li]:before:w-1.5 [&>li]:before:border-t [&>li:last-child]:after:absolute [&>li:last-child]:after:top-1/2 [&>li:last-child]:after:right-[calc(100%+0.375rem)] [&>li:last-child]:after:bottom-0 [&>li:last-child]:after:w-px">
                <SessionCardSkeleton showAgent={groupBy !== "agent"} coding={coding} />
              </SidebarMenuSub>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function SessionCardSkeleton({ showAgent, coding }: { showAgent: boolean; coding: boolean }) {
  return (
    <li aria-hidden="true" className="list-none rounded-md py-0.5">
      <div
        className={cn(
          "px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]",
          coding ? "h-20" : "h-16"
        )}
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          {showAgent || coding ? (
            <>
              <Skeleton className="bg-sidebar-border size-3.5 shrink-0 rounded-sm" />
              <div className="min-w-0 flex-1">
                <Skeleton className="bg-sidebar-border h-3 w-20" />
              </div>
            </>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <Skeleton className="bg-sidebar-border h-3 w-8 shrink-0" />
        </div>
        <div className={cn("mt-1 flex min-w-0 items-center gap-2", coding ? "h-5" : "h-6")}>
          <div className="min-w-0 flex-1">
            <Skeleton className="bg-sidebar-border h-4 w-3/4" />
          </div>
          {!coding ? (
            <div className="flex shrink-0 -space-x-[7px]">
              <Skeleton className="bg-sidebar-border ring-sidebar size-6 rounded-full ring-2" />
            </div>
          ) : null}
        </div>
        {coding ? (
          <div className="flex h-5 min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <Skeleton className="bg-sidebar-border h-3 w-2/3" />
            </div>
            <Skeleton className="bg-sidebar-border h-3 w-[7ch] shrink-0" />
          </div>
        ) : null}
      </div>
    </li>
  )
}

function AgentBadge({ status }: { status: AgentStatus | undefined }) {
  if (status && agentIsGettingReady(status)) {
    return (
      <span className={status === "DEGRADED" ? "text-destructive shrink-0" : "shrink-0"}>
        <Spinner aria-label="Getting ready" className="size-3" />
      </span>
    )
  }
  if (status === "IDLE") {
    return <Bot aria-label="Idle" className="text-primary size-4 shrink-0" role="status" />
  }
  return <Bot aria-label="Unavailable" className="text-destructive size-4 shrink-0" role="status" />
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
      <div className="text-sidebar-muted-foreground min-w-0 flex-1 truncate">
        {threadPending ? (
          <Skeleton
            aria-label="Loading branch"
            className="bg-sidebar-border h-3 w-2/3 motion-reduce:animate-none"
            role="status"
          />
        ) : (
          branch || worktree?.directory.split("/").at(-1)
        )}
      </div>
      {diffPending ? (
        <Skeleton
          aria-label="Loading diff stats"
          className="bg-sidebar-border h-3 w-[7ch] shrink-0 motion-reduce:animate-none"
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

function SessionCard({
  path,
  session,
  showAgent = true,
  workspaceId,
  workspaceType,
  workspacePath,
}: {
  path: string
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
  const [titleOverflows, setTitleOverflows] = useState(false)
  const titleRef = useRef<HTMLSpanElement>(null)
  const router = useRouter()
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

      await removeChatSessionFromCache(queryClient, workspaceId, session)
      const channel = new BroadcastChannel(`chatSessionDeletion:${workspaceId}`)
      channel.postMessage({
        agent_name: session.agent_name,
        session_id: session.session_id,
      } satisfies Pick<ChatSession, "agent_name" | "session_id">)
      channel.close()
      toast.success("Chat deleted")
      setConfirmingDelete(false)

      if (path === href) {
        const search = new URLSearchParams({
          agent: session.agent_name,
          draft: nanoid(),
        })
        router.push(`${workspacePath}/sessions/new?${search}` as Route, {
          showProgress: false,
        })
      }

      void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
      return result
    },
    { success: false }
  )

  const { setOpenMobile } = useSidebar()
  const participants = session.participants.slice(0, 3)
  const overflow = session.participants.length - participants.length
  const active = path === href

  useEffect(() => {
    const title = titleRef.current
    if (!title) return

    const observer = new ResizeObserver(() => {
      setTitleOverflows(title.scrollWidth > title.clientWidth)
    })
    observer.observe(title)

    return () => observer.disconnect()
  }, [session.title])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn(
            "group/session text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-within:bg-sidebar-accent focus-within:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground relative list-none rounded-md py-0.5 transition-colors",
            active && "bg-sidebar-accent text-sidebar-accent-foreground",
            coding && "rounded-lg"
          )}
        >
          <Link
            onClick={() => setOpenMobile(false)}
            aria-label={`Open ${session.title}`}
            aria-current={active ? "page" : undefined}
            className="focus-visible:ring-sidebar-ring absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset"
            href={href}
          />
          <div
            className={cn(
              "pointer-events-none relative px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]",
              coding ? "h-20" : "h-16"
            )}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
              {showAgent || coding ? (
                <>
                  <Bot aria-hidden="true" className="text-primary size-3.5 shrink-0" />
                  <span
                    className={cn(
                      "text-sidebar-muted-foreground min-w-0 flex-1 truncate font-medium",
                      coding && "font-semibold"
                    )}
                  >
                    {session.agent_name}
                  </span>
                </>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              <div className="text-sidebar-muted-foreground shrink-0 tabular-nums">
                {session.status === "idle" ? (
                  formatShortAge(new Date(session.updated_at).getTime())
                ) : coding ? (
                  <span className="text-info flex items-center gap-1 font-medium" role="status">
                    <LoaderCircle aria-hidden="true" className="size-3 motion-safe:animate-spin" />
                    Working
                  </span>
                ) : (
                  <AgentWorkingIndicator className="gap-0 [&>span:last-child]:sr-only" isWorking />
                )}
              </div>
            </div>
            <div className={cn("mt-1 flex min-w-0 items-center gap-2", coding ? "h-5" : "h-6")}>
              <h3
                className={cn(
                  "relative min-w-0 flex-1 overflow-hidden text-sm leading-5 font-medium",
                  coding && "text-sidebar-foreground/80 font-semibold",
                  coding && active && "text-sidebar-foreground"
                )}
              >
                <span
                  className={cn(
                    "block truncate",
                    titleOverflows && "motion-safe:group-hover/session:invisible"
                  )}
                  ref={titleRef}
                >
                  {session.title}
                </span>
                {titleOverflows ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 hidden w-max items-center motion-safe:group-hover/session:flex"
                  >
                    <span className="animate-session-title-marquee flex w-max items-center gap-8 whitespace-nowrap">
                      <span>{session.title}</span>
                      <span>{session.title}</span>
                    </span>
                  </span>
                ) : null}
              </h3>
              {!coding && session.participants.length > 0 ? (
                <div className="flex shrink-0 -space-x-[7px]">
                  {participants.map((participant) => (
                    <UserAvatar
                      email={participant.email}
                      id={participant.id}
                      image={participant.image}
                      key={participant.id}
                      name={participant.name}
                      size="sm"
                    />
                  ))}
                  {overflow > 0 ? (
                    <span className="bg-sidebar-control-surface text-sidebar-muted-foreground ring-sidebar grid size-6 place-items-center rounded-full text-[10px] ring-2">
                      +{overflow}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {coding ? <SessionCheckout session={session} workspaceId={workspaceId} /> : null}
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onSelect={() => setConfirmingDelete(true)} variant="destructive">
            <Trash2 aria-hidden="true" />
            Delete chat
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              Deleting <span className="font-medium">{session.title}</span> cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {pendingState.error ? (
            <DialogAlert variant="destructive">
              <AlertDescription>{pendingState.error.message}</AlertDescription>
            </DialogAlert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={isPending} variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <input name="sessionID" type="hidden" value={session.session_id} />
              <Button disabled={isPending} type="submit" variant="destructive">
                {isPending ? <Spinner /> : <Trash2 />}
                Delete
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ContextMenu>
  )
}

function chatSessionWatchOptions(workspaceId: string, userId: string) {
  return queryOptions({
    queryKey: ["watchChatSessions", workspaceId, userId],
    queryFn: streamedQuery<WatchChatSessionsEvent, string, ["watchChatSessions", string, string]>({
      initialValue: "",
      reducer: (_, event) => event.revision,
      streamFn: async ({ signal }) => {
        const result = await watchChatSessions({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
        })
        return result.stream
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
