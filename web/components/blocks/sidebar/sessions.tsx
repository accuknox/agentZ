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
import { Bot, Check, ChevronDown, Filter, MoreHorizontal, Plus, Trash2, Users } from "lucide-react"
import { nanoid } from "nanoid"
import { useEffect, useRef, useState, useTransition } from "react"
import { usePathname } from "next/navigation"
import { toast } from "sonner"
import { useActionState } from "react"
import { deleteAgentSessionAction } from "@/data/opencode.actions"
import type { DeleteSessionFormState, ListAgentActionResponse, WorkspacePath } from "@/data/types"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { UserAvatar, UserIdentity } from "@/components/ui/avatar"
import { Spinner } from "@/components/ui/spinner"
import { formatShortAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  listChatSessions,
  updateChatSessionPreference,
  watchChatSessions,
  type ChatSession,
  type ChatSessionPreference,
  type ListChatSessionsResponse,
  type WatchChatSessionsEvent,
} from "@/lib/gateway/client"

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

type SessionPages = {
  pages: ListChatSessionsResponse[]
  pageParams: (string | undefined)[]
}

type PreferenceMutation = {
  next: ChatSessionPreference
  previous: ChatSessionPreference
}

const chatSessionKeys = {
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
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
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
  const [preferences, setPreferences] = useState(initialPreferences)
  const preferencesRef = useRef(initialPreferences)
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
      ? ({ pages: [initialSessions], pageParams: [undefined] } satisfies SessionPages)
      : undefined,
    placeholderData: keepPreviousData,
  })
  const mutation = useMutation({
    scope: { id: `chat-preferences:${workspaceId}` },
    mutationFn: async ({ next }: PreferenceMutation) => {
      const result = await updateChatSessionPreference({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        body: {
          agent_name: next.agent_name,
          include_workflow_runs: next.include_workflow_runs,
          last_agent_name: next.last_agent_name,
          participant_user_ids: next.participant_user_ids,
        },
      })
      if (result.error) throw result.error
      return result.data
    },
    onError: (_, { next, previous }) => {
      if (preferencesRef.current !== next) return
      preferencesRef.current = previous
      setPreferences(previous)
      toast.error("Could not save chat filters")
    },
    onSuccess: (saved, { next }) => {
      if (preferencesRef.current !== next) return
      preferencesRef.current = saved
      setPreferences(saved)
    },
  })
  const watch = useQuery(chatSessionWatchOptions(workspaceId))

  useEffect(() => {
    if (!watch.data) return
    void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
  }, [queryClient, watch.data, workspaceId])

  const updatePreferences = (update: (current: ChatSessionPreference) => ChatSessionPreference) => {
    const previous = preferencesRef.current
    const next = update(previous)
    preferencesRef.current = next
    setPreferences(next)
    mutation.mutate({ next, previous })
  }
  const rows = sessions.data?.pages.flatMap((page) => page.sessions) ?? []
  const participantFilters =
    sessions.data?.pages[0]?.participant_filters ?? initialSessions.participant_filters
  const activeFilterCount =
    (preferences.agent_name ? 1 : 0) +
    preferences.participant_user_ids.length +
    (preferences.include_workflow_runs ? 1 : 0)
  const newSessionPath = `${workspacePath}/sessions/new?draft=${nanoid()}` as Route

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 group-data-[collapsible=icon]:hidden">
      <div className="flex items-center gap-1.5 px-2">
        <Button
          className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 h-8 min-w-0 flex-1 justify-start shadow-xs"
          onClick={() => router.push(newSessionPath)}
          size="sm"
        >
          <Plus aria-hidden="true" />
          New chat
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label="Filter chats"
              className="relative size-8"
              size="icon-sm"
              variant="outline"
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
              <p className="text-sm font-medium">Agent</p>
              <div className="mt-1.5 grid gap-0.5">
                <FilterChoice
                  checked={preferences.agent_name === null}
                  label="All agents"
                  onSelect={() =>
                    updatePreferences((current) => ({
                      ...current,
                      agent_name: null,
                      updated_at: new Date().toISOString(),
                    }))
                  }
                />
                {availableAgents.map((agent) => (
                  <FilterChoice
                    checked={preferences.agent_name === agent.name}
                    key={agent.name}
                    label={agent.name}
                    onSelect={() =>
                      updatePreferences((current) => ({
                        ...current,
                        agent_name: agent.name,
                        updated_at: new Date().toISOString(),
                      }))
                    }
                  />
                ))}
              </div>
            </div>
            <div>
              <p className="text-sm font-medium">People in chat</p>
              {participantFilters.length === 0 ? (
                <p className="text-muted-foreground mt-1.5 text-xs">No participants yet</p>
              ) : (
                <div className="mt-1.5 grid gap-1">
                  {participantFilters.map((participant) => {
                    const checked = preferences.participant_user_ids.includes(participant.id)
                    return (
                      <label
                        className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1"
                        key={participant.id}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => {
                            updatePreferences((current) => {
                              const selected = current.participant_user_ids.includes(participant.id)
                              const ids = selected
                                ? current.participant_user_ids.filter((id) => id !== participant.id)
                                : [...current.participant_user_ids, participant.id]
                              return {
                                ...current,
                                participant_user_ids: ids,
                                updated_at: new Date().toISOString(),
                              }
                            })
                          }}
                        />
                        <UserIdentity
                          email={participant.email}
                          image={participant.image}
                          name={participant.name}
                          secondary={false}
                        />
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-2 border-t pt-3 text-sm">
              <Checkbox
                checked={preferences.include_workflow_runs}
                onCheckedChange={(checked) =>
                  updatePreferences((current) => ({
                    ...current,
                    include_workflow_runs: checked === true,
                    updated_at: new Date().toISOString(),
                  }))
                }
              />
              Show workflow run chats
            </label>
          </PopoverContent>
        </Popover>
      </div>

      <div className="min-h-0 overflow-y-auto px-2 pb-2">
        {sessions.isPending ? (
          <div className="grid gap-2 py-1">
            <div className="bg-sidebar-accent/60 h-20 animate-pulse rounded-xl" />
            <div className="bg-sidebar-accent/60 h-20 animate-pulse rounded-xl" />
          </div>
        ) : null}
        {sessions.isError ? (
          <p className="text-destructive px-1 py-3 text-sm">Could not load chats</p>
        ) : null}
        {!sessions.isPending && rows.length === 0 ? (
          <div className="text-muted-foreground px-2 py-8 text-center text-sm">
            <Users className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
            No chats match these filters
          </div>
        ) : null}
        <div className="grid min-w-0 gap-1.5">
          {rows.map((session) => (
            <SessionCard
              key={`${session.agent_name}:${session.session_id}`}
              path={path}
              session={session}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
            />
          ))}
        </div>
        {sessions.hasNextPage ? (
          <Button
            className="text-muted-foreground mt-2 w-full"
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

function FilterChoice({
  checked,
  label,
  onSelect,
}: {
  checked: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <button
      className="hover:bg-accent flex h-8 items-center justify-between rounded-md px-2 text-left text-sm"
      onClick={onSelect}
      type="button"
    >
      <span className="truncate">{label}</span>
      {checked ? <Check className="text-primary size-4" aria-hidden="true" /> : null}
    </button>
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
  const [pendingState, action, isPending] = useActionState<DeleteSessionFormState, FormData>(
    deleteAgentSessionAction.bind(null, session.agent_name, workspaceId),
    { success: false }
  )
  const [isTransitionPending, startTransition] = useTransition()
  const router = useRouter()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (isPending || !pendingState.success) return
    toast.success("Chat deleted")
    void queryClient.invalidateQueries({ queryKey: chatSessionKeys.workspace(workspaceId) })
    startTransition(() => {
      setConfirmingDelete(false)
      if (path === href) {
        router.push(`${workspacePath}/sessions/new?draft=${nanoid()}` as Route)
      }
      router.refresh()
    })
  }, [href, isPending, path, pendingState.success, queryClient, router, workspaceId, workspacePath])

  const participants = session.participants.slice(0, 3)
  const overflow = session.participants.length - participants.length
  return (
    <article
      className={
        path === href
          ? "group/session border-sidebar-primary/20 bg-sidebar-accent relative w-full min-w-0 rounded-xl border px-2.5 py-2 shadow-xs"
          : "group/session border-sidebar-border/70 bg-sidebar-accent/35 hover:bg-sidebar-accent relative w-full min-w-0 rounded-xl border px-2.5 py-2 transition-colors"
      }
    >
      <Link
        aria-label={`Open ${session.title}`}
        className="absolute inset-0 rounded-xl"
        href={href}
      />
      <div className="pointer-events-none relative flex items-center gap-1.5 pr-6">
        <Bot className="text-primary size-3.5" aria-hidden="true" />
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium">
          {session.agent_name}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {session.status === "idle" ? (
            formatShortAge(new Date(session.updated_at).getTime())
          ) : (
            <SessionSpinner />
          )}
        </span>
      </div>
      <h3 className="pointer-events-none relative mt-1 truncate pr-6 text-[13px] leading-5 font-medium">
        {session.title}
      </h3>
      {session.participants.length > 0 ? (
        <div className="pointer-events-none relative mt-1.5 flex -space-x-1.5">
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
            <span className="bg-muted text-muted-foreground ring-sidebar grid size-6 place-items-center rounded-full text-[10px] ring-2">
              +{overflow}
            </span>
          ) : null}
        </div>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`Actions for ${session.title}`}
            className="hover:bg-sidebar-accent focus-visible:ring-sidebar-ring absolute top-1.5 right-1.5 z-10 grid size-6 place-items-center rounded-md opacity-0 outline-none group-hover/session:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
            type="button"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setConfirmingDelete(true)} variant="destructive">
            <Trash2 aria-hidden="true" />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
              <Button disabled={isPending || isTransitionPending} variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <input name="sessionID" type="hidden" value={session.session_id} />
              <Button
                disabled={isPending || isTransitionPending}
                type="submit"
                variant="destructive"
              >
                {isPending || isTransitionPending ? <Spinner /> : <Trash2 />}
                Delete
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}

function SessionSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const interval = window.setInterval(
      () => setFrame((current) => (current + 1) % spinnerFrames.length),
      80
    )
    return () => window.clearInterval(interval)
  }, [])
  return (
    <span aria-label="Working" role="status">
      {spinnerFrames[frame]}
    </span>
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
