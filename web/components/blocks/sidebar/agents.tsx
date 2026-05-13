"use client"

import Link from "next/link"
import { use, useCallback, useState, useTransition } from "react"
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
import { deleteAgentSessionAction, listAgentSessionsAction } from "@/data/opencode.actions"
import type { AgentSessionListItem, ListAgentActionResponse } from "@/data/types"
import { usePathname, useRouter } from "next/navigation"

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
  const [openAgentName, setOpenAgentName] = useState<string | null>(null)
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
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: Infinity,
    })
  )

  const error = list.error ?? toGatewayError(query.error)
  const queryAgents = query.data ?? initialAgents

  const path = usePathname()

  if (error) {
    return (
      <SidebarMenuSubItem key="error">
        <p className="text-sm text-destructive">{error.message}</p>
      </SidebarMenuSubItem>
    )
  }

  if (queryAgents.length === 0) {
    return (
      <SidebarMenuSubItem key="empty">
        <p className="text-sm text-muted-foreground">No sessions</p>
      </SidebarMenuSubItem>
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
          setOpenAgentName={setOpenAgentName}
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
  const sessionsQueryOptions = agentSessionsQueryOptions(agent.name, isOpen)
  const query = useQuery(sessionsQueryOptions)

  const sessions = query.data ?? []
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpenAgentName(open ? agent.name : null)
    },
    [agent.name, setOpenAgentName]
  )

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
                  <div className="space-y-1">
                    <SidebarMenuSkeleton />
                    <SidebarMenuSkeleton />
                  </div>
                </SidebarMenuSubItem>
              ) : null}
              {query.isError ? (
                <SidebarMenuSubItem key="error">
                  <p className="text-sm text-destructive">{query.error.message}</p>
                </SidebarMenuSubItem>
              ) : null}
              {!query.isPending && !query.isError && sessions.length === 0 ? (
                <SidebarMenuSubItem key="empty">
                  <p className="text-sm text-muted-foreground">No sessions</p>
                </SidebarMenuSubItem>
              ) : null}
              {sessions.map((session) => (
                <SessionItem
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
    (formData: FormData) => {
      setError(null)
      startTransition(async () => {
        const state = await deleteAgentSessionAction(agentName, { success: false }, formData)

        if (state.error) {
          setError(new Error(state.error.message))
          return
        }

        setOpen(false)

        void queryClient.invalidateQueries({
          queryKey: agentSessionsQueryOptions(agentName, true).queryKey,
        })

        if (path === href) {
          await router.push(`/agents/${agentName}/session/new`)
          router.refresh()
        }
      })
    },
    [agentName, href, path, queryClient, router]
  )

  return (
    <>
      <SidebarMenuSubItem key={session.id}>
        <SidebarMenuSubButton
          asChild
          className="min-w-0 flex-1 data-[active=true]:bg-transparent data-[active=true]:font-normal"
          isActive={path === href}
        >
          <Link className="flex min-w-0 flex-1 items-center" href={href}>
            <span className="ml-1.5 truncate text-muted-foreground group-data-[active=true]/menu-sub-button:text-foreground group-hover/menu-sub-button:text-inherit">
              {session.title}
            </span>
          </Link>
        </SidebarMenuSubButton>
        <SidebarMenuAction
          aria-label={`Delete ${session.title}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          showOnHover
          onClick={() => setOpen(true)}
        >
          {isPending ? <Spinner className="size-3" /> : <Trash2 />}
        </SidebarMenuAction>
      </SidebarMenuSubItem>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-medium">{session.title}</span>.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
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
    queryFn: async () => {
      const result = await listAgentSessionsAction(agentName)
      if (result.error) {
        throw new Error(result.error.message)
      }

      return result.sessions
    },
    queryKey: ["agentSessions", agentName],
    retry: false,
    staleTime: 30_000,
  })
}

function AgentBadge({ status }: { status: AgentStatus }) {
  switch (status) {
    case "PROGRESSING":
      return (
        <span className="shrink-0 text-chat-interrupted">
          <Spinner aria-label="Provisioning" className="size-3" />
        </span>
      )
    case "DEGRADED":
      return (
        <span className="shrink-0 text-destructive">
          <Spinner aria-label="Degraded" className="size-3" />
        </span>
      )
    case "IDLE":
      return <BotIcon aria-label="Idle" role="status" className="text-chat-active" />
    default:
      return <BotIcon aria-label="Unknown" role="status" className="text-destructive" />
  }
}
