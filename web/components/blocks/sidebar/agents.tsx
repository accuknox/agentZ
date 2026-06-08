"use client"

import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { motion } from "motion/react"
import { use, useCallback, useEffect, useMemo, useState, useTransition } from "react"
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
import { dayjs } from "@/lib/dayjs"
import {
  watchAgents,
  type Agent,
  type Error as GatewayError,
  type AgentStatus,
  type WatchAgentsResponse,
} from "@/lib/gateway/client"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { deleteAgentSessionAction } from "@/data/opencode.actions"
import type { AgentSessionListItem, ListAgentActionResponse } from "@/data/types"
import { usePathname } from "next/navigation"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import {
  applySessionLifecycleEvent,
  isSessionLifecycleEvent,
  sortAgentSessions,
  toAgentSessionListItem,
} from "@/lib/opencode/session-list"
import type { Event as OpencodeEvent } from "@opencode-ai/sdk"

const MotionSidebarMenuSubItem = motion.create(SidebarMenuSubItem)

type SessionStreamChunk =
  | {
      type: "snapshot"
      sessions: AgentSessionListItem[]
    }
  | {
      type: "event"
      event: OpencodeEvent
    }

export function NavAgentsSkeleton() {
  return (
    <SidebarMenu>
      <Collapsible asChild defaultOpen className="group/collapsible">
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip="Agents">
              <BotIcon />
              <span>Agents</span>
              <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              <SidebarMenuSubItem key="skeleton">
                <SidebarMenuSkeleton />
                <SidebarMenuSkeleton />
              </SidebarMenuSubItem>
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </SidebarMenu>
  )
}

export function NavAgents({ agents }: { agents: Promise<ListAgentActionResponse> }) {
  const list = use(agents)
  const initialAgents = list.agents ?? []
  const path = usePathname()
  const currentAgentName = agentNameFromPath(path)
  const [manualOpenAgentName, setManualOpenAgentName] = useState<string | null>(null)
  const openAgentName = currentAgentName ?? manualOpenAgentName

  const query = useQuery(
    queryOptions({
      enabled: Boolean(list.agents),
      placeholderData: initialAgents,
      queryFn: streamedQuery<WatchAgentsResponse, Agent[], ["watchAgents"]>({
        initialValue: initialAgents,
        refetchMode: "reset",
        reducer: (agents, event) => {
          const byName = new Map(agents.map((agent) => [agent.name, agent]))

          for (const agent of event.agents) {
            if (agent.status === "DELETED") {
              byName.delete(agent.name)
              continue
            }

            byName.set(agent.name, agent)
          }

          return Array.from(byName.values()).sort((x, y) => {
            return (
              Date.parse(y.modified_at) - Date.parse(x.modified_at) || x.name.localeCompare(y.name)
            )
          })
        },
        streamFn: async ({ signal }) => {
          const result = await watchAgents({ signal })
          return result.stream
        },
      }),
      queryKey: ["watchAgents"],
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: true,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      staleTime: Infinity,
    })
  )

  const error = list.error ?? toGatewayError(query.error)
  const queryAgents = query.data ?? initialAgents

  if (error) {
    return (
      <SidebarMenuSubItem key="error">
        <p className="text-destructive text-sm">{error.message}</p>
      </SidebarMenuSubItem>
    )
  }

  if (queryAgents.length === 0) {
    return <></>
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
}: {
  agent: Agent
  isOpen: boolean
  path: string
  setOpenAgentName: React.Dispatch<React.SetStateAction<string | null>>
}) {
  const query = useLiveAgentSessions(agent.name, isOpen)
  const sessions = useMemo(() => query.data ?? [], [query.data])
  const displaySessions = sessions.filter((s) => !s.parentID)
  const router = useRouter()
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpenAgentName(open ? agent.name : null)
    },
    [agent.name, setOpenAgentName]
  )

  useEffect(() => {
    if (!isOpen) return

    const sessionID = sessionIDFromPath(path, agent.name)
    if (!sessionID) return
    if (query.isPending) return
    if (query.isError) return
    if (sessions.some((session) => session.id === sessionID)) return

    void router.push(`/agents/${agent.name}/session/new`)
  }, [agent.name, isOpen, path, query.isError, query.isPending, router, sessions])

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
          <SidebarMenuAction>
            <Link href={`/agents/${agent.name}/session/new`}>
              <Plus size={16} />
              <span className="sr-only">New Session</span>
            </Link>
          </SidebarMenuAction>
          <CollapsibleContent>
            <SidebarMenuSub>
              {query.isPending ? (
                <SidebarMenuSubItem key="loading">
                  <div className="flex flex-col gap-1">
                    <SidebarMenuSkeleton />
                    <SidebarMenuSkeleton />
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
}: {
  agentName: string
  path: string
  session: AgentSessionListItem
}) {
  const href = `/agents/${agentName}/${session.id}`
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [isPending, startTransition] = useTransition()
  const queryClient = useQueryClient()
  const router = useRouter()

  const handleDelete = useCallback(
    async (formData: FormData) => {
      setError(null)
      const state = await deleteAgentSessionAction(agentName, { success: false }, formData)

      if (state.error) {
        setError(new Error(state.error.message))
        return
      }

      startTransition(() => {
        setOpen(false)

        void queryClient.invalidateQueries({
          queryKey: agentSessionsQueryOptions(agentName, true).queryKey,
        })

        if (path === href) {
          router.push(`/agents/${agentName}/session/new`)
          router.refresh()
        }
      })
    },
    [agentName, href, path, queryClient, router]
  )

  return (
    <>
      <SidebarMenuSubButton
        asChild
        className="min-w-0 flex-1 pr-10 data-[active=true]:font-normal"
        isActive={path === href}
      >
        <Link className="flex min-w-0 flex-1 items-center" href={href}>
          <span className="group-data-[active=true]/menu-sub-button:text-foreground truncate text-[14px] font-normal group-hover/menu-sub-button:text-inherit">
            {session.title}
          </span>
        </Link>
      </SidebarMenuSubButton>
      <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs font-normal group-focus-within/menu-sub-item:opacity-0 group-hover/menu-sub-item:opacity-0">
        {formatSessionLastActivity(session.updatedAt)}
      </span>
      <button
        type="button"
        aria-label={`Delete ${session.title}`}
        className="text-destructive ring-sidebar-ring hover:bg-destructive/10 hover:text-destructive absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 outline-hidden transition-opacity group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
        onClick={() => setOpen(true)}
      >
        {isPending ? <Spinner className="size-3" /> : <Trash2 size={16} />}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-medium">{session.title}</span>.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {error.message}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isPending}>
                Cancel
              </Button>
            </DialogClose>
            <form action={handleDelete}>
              <input type="hidden" name="sessionID" value={session.id} />
              <Button type="submit" variant="destructive" disabled={isPending}>
                {isPending ? <Spinner /> : <Trash2 />}
                Delete
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function toGatewayError(err: Error | null): GatewayError | undefined {
  if (!err) {
    return undefined
  }
  return {
    code: "SSE_ERROR",
    message: err.message,
  }
}

function agentSessionsQueryOptions(agentName: string, enabled: boolean) {
  return queryOptions({
    enabled,
    queryFn: streamedQuery<SessionStreamChunk, AgentSessionListItem[], ["agentSessions", string]>({
      initialValue: [],
      reducer: (sessions, chunk) => {
        if (chunk.type === "snapshot") {
          return sortAgentSessions(chunk.sessions)
        }

        if (!isSessionLifecycleEvent(chunk.event)) {
          return sessions
        }

        return applySessionLifecycleEvent(sessions, chunk.event)
      },
      streamFn: async function* ({ signal }) {
        const client = createAgentOpencodeClient(agentName)
        const listResult = await client.session.list()
        if (!listResult.data) {
          throw new Error("Failed to load sessions")
        }

        yield {
          type: "snapshot",
          sessions: sortAgentSessions(listResult.data.map(toAgentSessionListItem)),
        }

        const subscription = await client.event.subscribe({
          signal,
        })

        for await (const event of subscription.stream) {
          yield {
            type: "event",
            event,
          }
        }
      },
      refetchMode: "reset",
    }),
    queryKey: ["agentSessions", agentName],
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })
}

function useLiveAgentSessions(agentName: string, enabled: boolean) {
  return useQuery(agentSessionsQueryOptions(agentName, enabled))
}

function agentNameFromPath(path: string) {
  const match = path.match(/^\/agents\/([^/]+)(?:\/.*)?$/)
  if (!match) return null
  return decodeURIComponent(match[1])
}

function sessionIDFromPath(path: string, agentName: string) {
  const match = path.match(/^\/agents\/([^/]+)\/([^/]+)$/)
  if (!match) return
  if (decodeURIComponent(match[1]) !== agentName) return
  if (match[2] === "session") return
  return decodeURIComponent(match[2])
}

function AgentBadge({ status }: { status: AgentStatus }) {
  switch (status) {
    case "PROGRESSING":
      return (
        <span className="text-accent shrink-0">
          <Spinner aria-label="Provisioning" className="size-3" />
        </span>
      )
    case "DEGRADED":
      return (
        <span className="text-destructive shrink-0">
          <Spinner aria-label="Degraded" className="size-3" />
        </span>
      )
    case "IDLE":
      return <BotIcon aria-label="Idle" role="status" className="text-primary" />
    default:
      return <BotIcon aria-label="Unknown" role="status" className="text-destructive" />
  }
}

function formatSessionLastActivity(updatedAt: number) {
  const t = dayjs(updatedAt)
  const now = dayjs()
  const minute = now.diff(t, "minute")
  if (minute < 1) return "now"
  if (minute < 60) return `${minute}m`

  const hour = now.diff(t, "hour")
  if (hour < 24) return `${hour}h`

  const day = now.diff(t, "day")
  if (day < 7) return `${day}d`

  const week = now.diff(t, "week")
  if (week < 5) return `${week}w`

  const month = now.diff(t, "month")
  if (month < 12) return `${month}mo`

  return `${now.diff(t, "year")}y`
}
