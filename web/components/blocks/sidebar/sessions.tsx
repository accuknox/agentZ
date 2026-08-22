"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import {
  experimental_streamedQuery as streamedQuery,
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Bot, ChevronDown, Filter, SquarePen, Trash2, Users } from "lucide-react"
import { nanoid } from "nanoid"
import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { toast } from "sonner"
import { useActionState } from "react"
import { deleteAgentSessionAction } from "@/data/opencode.actions"
import type { DeleteSessionFormState, ListAgentActionResponse, WorkspacePath } from "@/data/types"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { AgentWorkingIndicator } from "@/components/agent-working-indicator"
import { Button } from "@/components/ui/button"
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
import { formatShortAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { cn } from "@/lib/utils"
import {
  listChatSessions,
  getChatSessionPreference,
  updateChatSessionPreference,
  watchChatSessions,
  type ChatSession,
  type ChatSessionPreference,
  type ListChatSessionsResponse,
  type WatchChatSessionsEvent,
} from "@/lib/gateway/client"

type PreferenceMutation = {
  next: ChatSessionPreference
  previous: ChatSessionPreference
}

const allAgentsValue = "__all_agents__"

const chatSessionKeys = {
  preference: (workspaceId: string) => ["chatSessionPreference", workspaceId] as const,
  workspace: (workspaceId: string) => ["chatSessions", workspaceId] as const,
  list: (workspaceId: string, preferences: ChatSessionPreference) =>
    [
      "chatSessions",
      workspaceId,
      preferences.agent_name,
      preferences.include_workflow_runs,
      preferences.participant_user_ids,
    ] as const,
}

function chatSessionsOptions(workspaceId: string, preferences: ChatSessionPreference) {
  return infiniteQueryOptions({
    queryKey: chatSessionKeys.list(workspaceId, preferences),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const result = await listChatSessions({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        query: {
          agent_name: preferences.agent_name ?? undefined,
          include_workflow_runs: preferences.include_workflow_runs,
          limit: pageParam ? 25 : 10,
          page_token: pageParam,
          participant_user_id: preferences.participant_user_ids,
        },
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
}: {
  agents: ListAgentActionResponse
  initialPreferences: ChatSessionPreference
  initialSessions: ListChatSessionsResponse
  workspaceId: string
  workspacePath: WorkspacePath
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const path = usePathname()
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
    preferences.participant_user_ids.length === initialPreferences.participant_user_ids.length &&
    preferences.participant_user_ids.every(
      (id, index) => id === initialPreferences.participant_user_ids[index]
    )
  const sessions = useInfiniteQuery({
    ...chatSessionsOptions(workspaceId, preferences),
    initialData: matchesInitialPreferences
      ? { pages: [initialSessions], pageParams: [undefined] }
      : undefined,
    placeholderData: keepPreviousData,
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

  const updatePreferences = (update: (current: ChatSessionPreference) => ChatSessionPreference) => {
    const previous = queryClient.getQueryData<ChatSessionPreference>(preferenceKey) ?? preferences
    const next = update(previous)
    queryClient.setQueryData(preferenceKey, next)
    mutation.mutate({ next, previous })
  }
  const rows = sessions.data?.pages.flatMap((page) => page.sessions) ?? []
  const participantFilters =
    sessions.data?.pages[0]?.participant_filters ?? initialSessions.participant_filters
  const activeFilterCount =
    (preferences.agent_name ? 1 : 0) +
    preferences.participant_user_ids.length +
    (preferences.include_workflow_runs ? 1 : 0)

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

      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--sidebar-content-inset)] pb-2">
        {sessions.isPending ? (
          <div className="grid gap-1 py-1">
            <div className="bg-sidebar-control-surface h-16 animate-pulse rounded-md" />
            <div className="bg-sidebar-control-surface h-16 animate-pulse rounded-md" />
          </div>
        ) : null}
        {sessions.isError ? (
          <p className="text-destructive px-1 py-3 text-sm">Could not load chats</p>
        ) : null}
        {!sessions.isPending && rows.length === 0 ? (
          <div className="text-sidebar-muted-foreground px-2 py-8 text-center text-sm">
            <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
            No chats found
          </div>
        ) : null}
        <ul className="flex min-w-0 flex-col gap-0.5">
          {rows.map((session) => (
            <SessionCard
              key={`${session.agent_name}:${session.session_id}`}
              path={path}
              session={session}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
            />
          ))}
        </ul>
        {sessions.hasNextPage ? (
          <Button
            className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground mt-2 w-full"
            disabled={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
            size="sm"
            variant="ghost"
          >
            {sessions.isFetchingNextPage ? <Spinner /> : <ChevronDown />}
            Show 25 more
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SessionCard({
  path,
  session,
  workspaceId,
  workspacePath,
}: {
  path: string
  session: ChatSession
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
              <Bot className="text-sidebar-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
              <span className="text-sidebar-muted-foreground min-w-0 flex-1 truncate font-medium">
                {session.agent_name}
              </span>
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
