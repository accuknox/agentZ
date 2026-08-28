"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import {
  experimental_streamedQuery as streamedQuery,
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Filter,
  ListTree,
  Plus,
  Search,
  SquarePen,
  Trash2,
  Users,
  X,
} from "lucide-react"
import { nanoid } from "nanoid"
import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { toast } from "sonner"
import { useActionState } from "react"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { UserAvatar } from "@/components/ui/avatar"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { useSidebar } from "@/components/ui/sidebar"
import { formatShortAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { cn } from "@/lib/utils"
import {
  listChatSessions,
  getChatSessionPreference,
  updateChatSessionPreference,
  watchChatSessions,
  type ChatSession,
  type ChatSessionGroup,
  type ChatSessionPreference,
  type AgentStatus,
  type ListChatSessionsResponse,
  type WatchChatSessionsEvent,
} from "@/lib/gateway/client"

type PreferenceMutation = {
  next: ChatSessionPreference
  previous: ChatSessionPreference
}

type NavSessionsProps = {
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
  activeSessionId: string | undefined
) {
  return infiniteQueryOptions({
    queryKey: chatSessionKeys.list(
      workspaceId,
      preferences,
      search,
      timeZone,
      activeAgentName,
      activeSessionId
    ),
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

export function NavSessions({
  agents,
  initialPreferences,
  initialSessions,
  workspaceId,
  workspacePath,
}: NavSessionsProps) {
  const { isMobile, state } = useSidebar()
  if (!isMobile && state === "collapsed") return null

  return (
    <NavSessionsContent
      agents={agents}
      initialPreferences={initialPreferences}
      initialSessions={initialSessions}
      workspaceId={workspaceId}
      workspacePath={workspacePath}
    />
  )
}

function NavSessionsContent({
  agents,
  initialPreferences,
  initialSessions,
  workspaceId,
  workspacePath,
}: NavSessionsProps) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const path = usePathname()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState("")
  const [search, setSearch] = useState("")
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [dateBoundary, setDateBoundary] = useState(0)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const searchInput = useRef<HTMLInputElement>(null)
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
    const value = searchText.trim()
    const timer = window.setTimeout(
      () => setSearch(value.length === 0 || value.length >= 3 ? value : ""),
      250
    )
    return () => window.clearTimeout(timer)
  }, [searchText])

  const querySearch = searchText.trim() === search ? search : ""
  const preferenceKey = chatSessionKeys.preference(workspaceId)
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
      activeSessionId
    ),
    enabled:
      searchText.trim() === querySearch &&
      (searchText.trim().length === 0 || querySearch.length >= 3) &&
      (preferences.group_by !== "date" || timeZone !== ""),
    initialData:
      matchesInitialPreferences && querySearch === "" && preferences.group_by !== "date"
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
  const watch = useQuery(chatSessionWatchOptions(workspaceId))

  useEffect(() => {
    if (!watch.data) return
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
  const searchTooShort = searchText.trim().length > 0 && searchText.trim().length < 3
  const searchSettling = searchText.trim().length >= 3 && searchText.trim() !== querySearch

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-[var(--sidebar-content-inset)] pb-1">
        <Button
          className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground h-8 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 text-sm font-medium shadow-none"
          onClick={() => {
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
        <Button
          aria-label="Search chats"
          aria-pressed={searchOpen}
          className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground size-8 rounded-md border-0 bg-transparent shadow-none"
          onClick={() => setSearchOpen(true)}
          size="icon-sm"
          variant="ghost"
        >
          <Search aria-hidden="true" />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label="Group chats"
              className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground size-8 rounded-md border-0 bg-transparent shadow-none"
              size="icon-sm"
              variant="ghost"
            >
              <ListTree aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-3" side="right" sideOffset={8}>
            <label className="text-sm font-medium" htmlFor="chat-group-by">
              Group by
            </label>
            <Select
              value={preferences.group_by}
              onValueChange={(groupBy: ChatSessionPreference["group_by"]) =>
                updatePreferences((current) => ({ ...current, group_by: groupBy }))
              }
            >
              <SelectTrigger className="mt-1.5 w-full" id="chat-group-by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="status">State</SelectItem>
                  <SelectItem value="date">Date</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label="Filter chats"
              className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground relative size-8 rounded-md border-0 bg-transparent shadow-none"
              size="icon-sm"
              variant="ghost"
            >
              <Filter aria-hidden="true" />
              {activeFilterCount > 0 ? (
                <span className="bg-primary text-primary-foreground absolute -top-1 -right-1 grid size-4 place-items-center rounded-full text-[10px] font-semibold">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="max-h-[calc(100dvh-1rem)] w-72 gap-4 overflow-y-auto p-3"
            collisionPadding={8}
            side="right"
            sideOffset={8}
          >
            <div>
              <label className="text-sm font-medium" htmlFor="chat-agent-filter">
                Agent
              </label>
              <Select
                value={preferences.agent_name ?? allAgentsValue}
                onValueChange={(agentName) =>
                  updatePreferences((current) => ({
                    ...current,
                    agent_name: agentName === allAgentsValue ? null : agentName,
                  }))
                }
              >
                <SelectTrigger className="mt-1.5 w-full" id="chat-agent-filter">
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
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="chat-people-filter">
                People in chat
              </label>
              <MultiSelectDropdown
                className="mt-1.5"
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
            </div>
            <Separator className="-mx-3 w-[calc(100%+1.5rem)]" />
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={preferences.include_workflow_runs}
                onCheckedChange={(checked) =>
                  updatePreferences((current) => ({
                    ...current,
                    include_workflow_runs: checked === true,
                  }))
                }
              />
              Show workflow run chats
            </label>
          </PopoverContent>
        </Popover>
      </div>

      {searchOpen ? (
        <div className="relative px-[var(--sidebar-content-inset)] pb-1">
          <Search
            aria-hidden="true"
            className="text-sidebar-muted-foreground absolute top-2 left-[calc(var(--sidebar-content-inset)+0.625rem)] size-4"
          />
          <Input
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

      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--sidebar-content-inset)] pb-2">
        {searchTooShort ? (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-sm">
            Type at least 3 characters
          </p>
        ) : null}
        {!searchTooShort && (sessions.isPending || searchSettling) ? (
          <div className="grid gap-1 py-1">
            <div className="bg-sidebar-control-surface h-16 animate-pulse rounded-md" />
            <div className="bg-sidebar-control-surface h-16 animate-pulse rounded-md" />
          </div>
        ) : null}
        {!searchTooShort && sessions.isError ? (
          <p className="text-destructive px-1 py-3 text-sm">Could not load chats</p>
        ) : null}
        {!searchTooShort &&
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
          {preferences.group_by === "none" && !searchTooShort && !searchSettling
            ? rows.map((session) => (
                <SessionCard
                  key={`${session.agent_name}:${session.session_id}`}
                  path={path}
                  session={session}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                />
              ))
            : null}
        </ul>
        {preferences.group_by !== "none" && !searchTooShort && !searchSettling
          ? groups.map((group) => (
              <SessionGroup
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
                  setOpenGroups((current) => {
                    const next = new Set(current)
                    if (open) next.add(group.key)
                    else next.delete(group.key)
                    return next
                  })
                }}
                open={openGroups.has(group.key)}
                path={path}
                preferences={preferences}
                search={querySearch}
                timeZone={timeZone}
                workspaceId={workspaceId}
                workspacePath={workspacePath}
              />
            ))
          : null}
        {!sessions.isPending &&
        !searchSettling &&
        preferences.group_by !== "none" &&
        groups.length === 0 ? (
          <div className="text-sidebar-muted-foreground px-2 py-8 text-center text-sm">
            <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
            No chats found
          </div>
        ) : null}
        {preferences.group_by === "none" && !searchSettling && sessions.hasNextPage ? (
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
    </div>
  )
}

function SessionGroup({
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
  workspacePath,
}: {
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
  workspacePath: WorkspacePath
}) {
  const router = useRouter()
  const expanded = open || group.contains_active || search !== ""
  const agentName = group.agent_name
  const pages = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: chatSessionKeys.group(
        workspaceId,
        preferences,
        group.key,
        search,
        timeZone,
        activeAgentName,
        activeSessionId
      ),
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
      initialData: search !== "" ? { pages: [group], pageParams: [undefined] } : undefined,
      staleTime: Infinity,
    })
  )
  const sessions = pages.data?.pages.flatMap((page) => page.sessions) ?? []

  return (
    <Collapsible className="group/chat-group" onOpenChange={onOpenChange} open={expanded}>
      <div className="hover:bg-sidebar-accent focus-within:bg-sidebar-accent relative flex h-8 items-center rounded-md transition-colors">
        <CollapsibleTrigger asChild>
          <button
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label}`}
            className="focus-visible:ring-sidebar-ring text-sidebar-muted-foreground hover:text-sidebar-accent-foreground flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
            type="button"
          >
            {group.group_by === "agent" ? <AgentBadge status={agentStatus} /> : null}
            <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform duration-200 group-data-[state=open]/chat-group:rotate-90"
            />
          </button>
        </CollapsibleTrigger>
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
      <CollapsibleContent>
        {pages.isPending ? (
          <div className="grid gap-1 py-1">
            <div className="bg-sidebar-control-surface h-16 animate-pulse rounded-md" />
            <div className="bg-sidebar-control-surface h-16 animate-pulse rounded-md" />
          </div>
        ) : null}
        {pages.isError ? (
          <p className="text-destructive px-2 py-3 text-sm">Could not load chats</p>
        ) : null}
        {!pages.isPending && !pages.isError && sessions.length === 0 ? (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-sm">No chats</p>
        ) : null}
        <ul className="flex min-w-0 flex-col gap-0.5">
          {sessions.map((session) => (
            <SessionCard
              key={`${session.agent_name}:${session.session_id}`}
              path={path}
              session={session}
              showAgent={group.group_by !== "agent"}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
            />
          ))}
        </ul>
        {pages.hasNextPage ? (
          <Button
            className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground mt-2 w-full"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
            size="sm"
            variant="ghost"
          >
            {pages.isFetchingNextPage ? <Spinner /> : <ChevronDown />}
            Load more
          </Button>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
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

function SessionCard({
  path,
  session,
  showAgent = true,
  workspaceId,
  workspacePath,
}: {
  path: string
  session: ChatSession
  showAgent?: boolean
  workspaceId: string
  workspacePath: WorkspacePath
}) {
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
            "group/session text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-within:bg-sidebar-accent focus-within:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground relative list-none overflow-hidden rounded-md py-0.5 transition-colors",
            active && "bg-sidebar-accent text-sidebar-accent-foreground"
          )}
        >
          <Link
            aria-label={`Open ${session.title}`}
            aria-current={active ? "page" : undefined}
            className="focus-visible:ring-sidebar-ring absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset"
            href={href}
          />
          <div className="pointer-events-none relative h-16 px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
            <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
              {showAgent ? (
                <>
                  <Bot
                    aria-hidden="true"
                    className="text-sidebar-muted-foreground size-3.5 shrink-0"
                  />
                  <span className="text-sidebar-muted-foreground min-w-0 flex-1 truncate font-medium">
                    {session.agent_name}
                  </span>
                </>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              <span className="text-sidebar-muted-foreground shrink-0 tabular-nums">
                {session.status === "idle" ? (
                  formatShortAge(new Date(session.updated_at).getTime())
                ) : (
                  <AgentWorkingIndicator className="gap-0 [&>span:last-child]:sr-only" isWorking />
                )}
              </span>
            </div>
            <div className="mt-1 flex h-6 min-w-0 items-center gap-2">
              <h3 className="relative min-w-0 flex-1 overflow-hidden text-sm leading-5 font-medium">
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
              {session.participants.length > 0 ? (
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

function chatSessionWatchOptions(workspaceId: string) {
  return queryOptions({
    queryKey: ["watchChatSessions", workspaceId],
    queryFn: streamedQuery<WatchChatSessionsEvent, string, ["watchChatSessions", string]>({
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
