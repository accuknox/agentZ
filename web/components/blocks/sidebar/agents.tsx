"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { motion } from "motion/react"
import { nanoid } from "nanoid"
import { AgentDialog } from "@/app/agent/agent-dialog"
import { useActionState, useCallback, useEffect, useMemo, useState, useTransition } from "react"
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
import { Button } from "@/components/ui/button"
import {
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { BotIcon, ChevronRightIcon, Plus, Trash2 } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { formatShortAge } from "@/lib/format"
import type { Agent, AgentStatus, Skill } from "@/lib/gateway/client"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { agentIsGettingReady, watchAgentsQueryOptions } from "@/components/agent-readiness"
import { deleteAgentSessionAction } from "@/data/opencode.actions"
import type {
  AgentSessionListItem,
  DeleteSessionFormState,
  ListAgentActionResponse,
  ListSandboxActionResponse,
} from "@/data/types"
import { usePathname } from "next/navigation"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type {
  Event as OpencodeEvent,
  Session as OpencodeSession,
  SessionStatus,
} from "@opencode-ai/sdk/v2"

const MotionSidebarMenuSubItem = motion.create(SidebarMenuSubItem)

type AgentSessionsState = {
  sessions: AgentSessionListItem[]
  statuses: Record<string, SessionStatus>
}

type AgentSessionsStreamChunk =
  | {
      type: "snapshot"
      state: AgentSessionsState
    }
  | {
      type: "event"
      event: OpencodeEvent
    }

const sidebarSpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

function sortSessions(sessions: readonly AgentSessionListItem[]): AgentSessionListItem[] {
  return [...sessions].sort((x, y) => {
    return y.updatedAt - x.updatedAt || x.id.localeCompare(y.id)
  })
}

export function NavAgents({
  agents,
  immutableSkills,
  sandboxes,
  workspaceId,
  workspacePath,
}: {
  agents: ListAgentActionResponse
  immutableSkills: Skill[]
  sandboxes: ListSandboxActionResponse
  workspaceId: string
  workspacePath: string
}) {
  const initialAgents = agents.agents ?? []
  const path = usePathname()
  const currentAgentName = agentNameFromPath(path, workspacePath)
  const [manualOpenAgentName, setManualOpenAgentName] = useState<string | null>(null)
  const openAgentName = currentAgentName ?? manualOpenAgentName

  const query = useQuery({
    ...watchAgentsQueryOptions(workspaceId, initialAgents),
    enabled: agents.agents !== undefined,
  })

  const errorMessage = agents.error?.message ?? query.error?.message
  const queryAgents = query.data ?? initialAgents

  if (errorMessage) {
    return (
      <SidebarMenuSubItem key="error">
        <p className="text-destructive text-sm">{errorMessage}</p>
      </SidebarMenuSubItem>
    )
  }

  if (queryAgents.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <AgentDialog
            actionScope={{ basePath: workspacePath, workspaceId }}
            mode="create"
            immutableSkills={immutableSkills}
            sandboxes={sandboxes.error ? [] : sandboxes.sandboxes}
            initialHasNextSandboxPage={sandboxes.error ? false : sandboxes.hasNextPage}
            initialNextSandboxPageToken={sandboxes.error ? "" : sandboxes.nextPageToken}
            trigger={
              <SidebarMenuButton
                tooltip="Create"
                className="border-primary text-primary hover:bg-primary/5 hover:text-primary justify-center border border-dashed"
              >
                <Plus />
                <span className="group-data-[collapsible=icon]:hidden">Create</span>
              </SidebarMenuButton>
            }
          />
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <>
      {queryAgents.map((agent) => (
        <AgentSessionsItem
          key={agent.name}
          agent={agent}
          isOpen={openAgentName === agent.name}
          path={path}
          setOpenAgentName={setManualOpenAgentName}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
        />
      ))}
    </>
  )
}

function AgentSessionsItem({
  agent,
  isOpen,
  path,
  setOpenAgentName,
  workspaceId,
  workspacePath,
}: {
  agent: Agent
  isOpen: boolean
  path: string
  setOpenAgentName: React.Dispatch<React.SetStateAction<string | null>>
  workspaceId: string
  workspacePath: string
}) {
  const query = useQuery(agentSessionsQueryOptions(agent.name, workspaceId, isOpen))
  const sessions = useMemo(() => {
    return query.data?.sessions ?? []
  }, [query.data?.sessions])
  const statuses = query.data?.statuses ?? {}
  const displaySessions = useMemo(() => {
    return sessions.filter((session) => !session.parentID)
  }, [sessions])
  const router = useRouter()
  const newSessionPath =
    `${workspacePath}/agents/${encodeURIComponent(agent.name)}/sessions/new` as Route
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpenAgentName(open ? agent.name : null)
    },
    [agent.name, setOpenAgentName]
  )

  useEffect(() => {
    if (!isOpen) return

    const sessionID = sessionIDFromPath(path, workspacePath, agent.name)
    if (!sessionID) return
    if (query.isPending) return
    if (query.isError) return
    if (sessions.some((session) => session.id === sessionID)) return

    void router.push(`${newSessionPath}?draft=${nanoid()}` as Route)
  }, [
    agent.name,
    isOpen,
    newSessionPath,
    path,
    query.isError,
    query.isPending,
    router,
    sessions,
    workspacePath,
  ])

  return (
    <SidebarMenu>
      <Collapsible
        asChild
        className="group/collapsible"
        open={isOpen}
        onOpenChange={handleOpenChange}
      >
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip="Agents">
              <AgentBadge status={agent.status} />
              <span>{agent.name}</span>
              <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <SidebarMenuAction asChild>
            <Link
              href={newSessionPath}
              onClick={(event) => {
                event.preventDefault()
                void router.push(`${newSessionPath}?draft=${nanoid()}` as Route)
              }}
              prefetch={false}
            >
              <Plus size={16} />
              <span className="sr-only">New Session</span>
            </Link>
          </SidebarMenuAction>
          <CollapsibleContent>
            <SidebarMenuSub>
              {query.isPending ? (
                <SidebarMenuSubItem key="loading">
                  <div className="flex flex-col gap-1">
                    <SidebarMenuSkeleton className="[&_[data-slot=skeleton]]:bg-muted-foreground/20" />
                    <SidebarMenuSkeleton className="[&_[data-slot=skeleton]]:bg-muted-foreground/20" />
                  </div>
                </SidebarMenuSubItem>
              ) : null}
              {query.isError ? (
                <SidebarMenuSubItem key="error">
                  <p className="text-destructive text-sm">{query.error.message}</p>
                </SidebarMenuSubItem>
              ) : null}
              {!query.isPending && !query.isError && displaySessions.length === 0 ? (
                <SidebarMenuSubItem key="empty">
                  <p className="text-muted-foreground text-sm">No sessions</p>
                </SidebarMenuSubItem>
              ) : null}
              {displaySessions.map((session) => (
                <AnimatedSessionItem
                  key={session.id}
                  agentName={agent.name}
                  path={path}
                  session={session}
                  status={statuses[session.id]}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                />
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </SidebarMenu>
  )
}

function AnimatedSessionItem(props: {
  agentName: string
  path: string
  session: AgentSessionListItem
  status?: SessionStatus
  workspaceId: string
  workspacePath: string
}) {
  return (
    <MotionSidebarMenuSubItem
      layout="position"
      transition={{
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      <SessionItem {...props} />
    </MotionSidebarMenuSubItem>
  )
}

function SessionItem({
  agentName,
  path,
  session,
  status,
  workspaceId,
  workspacePath,
}: {
  agentName: string
  path: string
  session: AgentSessionListItem
  status?: SessionStatus
  workspaceId: string
  workspacePath: string
}) {
  const href =
    `${workspacePath}/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(session.id)}` as Route
  const [open, setOpen] = useState(false)
  const [pendingState, action, isPending] = useActionState<DeleteSessionFormState, FormData>(
    deleteAgentSessionAction.bind(null, agentName, workspaceId),
    { success: false }
  )
  const [isTransitionPending, startTransition] = useTransition()
  const queryClient = useQueryClient()
  const router = useRouter()
  const newSessionPath =
    `${workspacePath}/agents/${encodeURIComponent(agentName)}/sessions/new` as Route
  const isBusy = isPending || isTransitionPending

  useEffect(() => {
    if (isPending || !pendingState.success) return

    startTransition(() => {
      setOpen(false)

      void queryClient.invalidateQueries({
        queryKey: agentSessionsQueryOptions(agentName, workspaceId, true).queryKey,
      })

      if (path !== href) return

      router.push(`${newSessionPath}?draft=${nanoid()}` as Route)
      router.refresh()
    })
  }, [
    agentName,
    href,
    isPending,
    newSessionPath,
    path,
    pendingState.success,
    queryClient,
    router,
    workspaceId,
  ])

  return (
    <>
      <SidebarMenuSubButton
        asChild
        className="data-active:bg-sidebar-foreground/7 hover:bg-sidebar-foreground/7 min-w-0 flex-1 pr-10 data-active:font-normal"
        isActive={path === href}
      >
        <Link className="flex min-w-0 flex-1 items-center" href={href}>
          <span className="group-data-[active=true]/menu-sub-button:text-foreground truncate text-[14px] font-normal group-hover/menu-sub-button:text-inherit">
            {session.title}
          </span>
        </Link>
      </SidebarMenuSubButton>
      <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs font-normal group-focus-within/menu-sub-item:opacity-0 group-hover/menu-sub-item:opacity-0">
        {status && status.type !== "idle" ? (
          <SidebarSessionSpinner />
        ) : (
          formatShortAge(session.updatedAt)
        )}
      </span>
      <button
        type="button"
        aria-label={`Delete ${session.title}`}
        className="text-destructive ring-sidebar-ring hover:bg-destructive/10 hover:text-destructive absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 outline-hidden transition-opacity group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
        onClick={() => setOpen(true)}
      >
        {isTransitionPending ? <Spinner className="size-3" /> : <Trash2 size={16} />}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-medium">{session.title}</span>.
            </DialogDescription>
          </DialogHeader>
          {pendingState.error ? (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {pendingState.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isBusy}>
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <input type="hidden" name="sessionID" value={session.id} />
              <Button type="submit" variant="destructive" disabled={isBusy}>
                {isBusy ? <Spinner /> : <Trash2 />}
                Delete
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function agentSessionsQueryOptions(agentName: string, workspaceId: string, enabled: boolean) {
  return queryOptions({
    enabled,
    queryFn: streamedQuery<
      AgentSessionsStreamChunk,
      AgentSessionsState,
      ["agentSessions", string, string]
    >({
      initialValue: { sessions: [], statuses: {} },
      reducer: (state, chunk) => {
        if (chunk.type === "snapshot") {
          return chunk.state
        }

        switch (chunk.event.type) {
          case "session.created":
          case "session.updated":
          case "session.deleted": {
            const sessions = new Map(state.sessions.map((session) => [session.id, session]))
            const statuses = { ...state.statuses }
            const session = {
              id: chunk.event.properties.info.id,
              parentID: chunk.event.properties.info.parentID,
              title: chunk.event.properties.info.title,
              updatedAt: chunk.event.properties.info.time.updated,
            } satisfies AgentSessionListItem

            if (chunk.event.type === "session.deleted") {
              sessions.delete(session.id)
              delete statuses[session.id]
            } else {
              sessions.set(session.id, session)
            }

            return {
              sessions: sortSessions(Array.from(sessions.values())),
              statuses,
            }
          }
          case "session.status":
            return {
              sessions: state.sessions,
              statuses: {
                ...state.statuses,
                [chunk.event.properties.sessionID]: chunk.event.properties.status,
              },
            }
          case "session.idle":
            return {
              sessions: state.sessions,
              statuses: {
                ...state.statuses,
                [chunk.event.properties.sessionID]: { type: "idle" },
              },
            }
          default:
            return state
        }
      },
      streamFn: async function* ({ signal }) {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        const [listResult, statusResult] = await Promise.all([
          client.session.list(),
          client.session.status(),
        ])
        if (!listResult.data || !statusResult.data) {
          throw new Error("Failed to load sessions")
        }

        const sessions = sortSessions(
          listResult.data.map((session: OpencodeSession) => ({
            id: session.id,
            parentID: session.parentID,
            title: session.title,
            updatedAt: session.time.updated,
          }))
        )
        const visibleSessionIDs = new Set(sessions.map((session) => session.id))

        yield {
          type: "snapshot",
          state: {
            sessions,
            statuses: Object.fromEntries(
              Object.entries(statusResult.data).filter(([sessionID]) => {
                return visibleSessionIDs.has(sessionID)
              })
            ),
          },
        }

        const subscription = await client.event.subscribe(undefined, { signal })

        for await (const event of subscription.stream) {
          yield {
            type: "event",
            event,
          }
        }
      },
      refetchMode: "reset",
    }),
    queryKey: ["agentSessions", workspaceId, agentName],
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })
}

function SidebarSessionSpinner() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = window.setInterval(() => {
      setFrame((current) => {
        return (current + 1) % sidebarSpinnerFrames.length
      })
    }, 80)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  return (
    <span
      aria-label="Working"
      role="status"
      className="relative top-px inline-flex shrink-0 items-center align-middle text-[14px] leading-none"
    >
      {sidebarSpinnerFrames[frame]}
    </span>
  )
}

function agentNameFromPath(path: string, workspacePath: string) {
  const prefix = `${workspacePath}/agents/`
  if (!path.startsWith(prefix)) return null
  const [encodedAgentName] = path.slice(prefix.length).split("/")
  if (!encodedAgentName) return null

  return decodeURIComponent(encodedAgentName)
}

function sessionIDFromPath(path: string, workspacePath: string, agentName: string) {
  const prefix = `${workspacePath}/agents/`
  if (!path.startsWith(prefix)) return
  const [encodedAgentName, sessions, encodedSessionID] = path.slice(prefix.length).split("/")
  if (!encodedAgentName || !encodedSessionID) return
  if (decodeURIComponent(encodedAgentName) !== agentName) return
  if (sessions !== "sessions" || encodedSessionID === "new") return

  return decodeURIComponent(encodedSessionID)
}

function AgentBadge({ status }: { status: AgentStatus }) {
  if (agentIsGettingReady(status)) {
    return (
      <span className={status === "DEGRADED" ? "text-destructive shrink-0" : "shrink-0"}>
        <Spinner aria-label="Getting ready" className="size-3" />
      </span>
    )
  }

  if (status === "IDLE") {
    return <BotIcon aria-label="Idle" role="status" className="text-primary" />
  }

  return <BotIcon aria-label="Unknown" role="status" className="text-destructive" />
}
