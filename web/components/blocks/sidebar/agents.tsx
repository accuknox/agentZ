"use client"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarMenuAction,
} from "@/components/ui/sidebar"
import { BotIcon, ChevronRightIcon, Plus } from "lucide-react"
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
} from "@tanstack/react-query"
import { use } from "react"
import type { ListAgentActionResponse } from "@/data/types"
import { usePathname } from "next/navigation"
import Link from "next/link"

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
              <SidebarMenuSubItem>
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
  const query = useQuery(
    queryOptions({
      enabled: Boolean(list.agents),
      placeholderData: initialAgents,
      queryFn: streamedQuery<WatchAgentsResponse, Agent[], ["watchAgents"]>({
        initialValue: initialAgents,
        refetchMode: "reset",
        reducer: (agents, event) => {
          const byID = new Map(agents.map((agent) => [agent.session_id, agent]))

          for (const agent of event.agents) {
            if (agent.status === "DELETED") {
              byID.delete(agent.session_id)
              continue
            }

            byID.set(agent.session_id, agent)
          }

          return Array.from(byID.values()).sort((x, y) => {
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

  return (
    <SidebarMenu>
      <Collapsible
        asChild
        defaultOpen={path === "/" || path.startsWith("/agent")}
        className="group/collapsible"
      >
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip="Agents">
              <BotIcon />
              <span>Agents</span>
              <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <SidebarMenuAction>
            <Link href="/agent/new">
              <Plus size={16} />
              <span className="sr-only">New Agent</span>
            </Link>
          </SidebarMenuAction>
          <CollapsibleContent>
            <SidebarMenuSub>
              {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
              {!error && queryAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No agents</p>
              ) : null}
              {queryAgents.map((agent) => (
                <SidebarMenuSubItem key={agent.session_id}>
                  <SidebarMenuSubButton asChild>
                    <Link href={`/agents/${agent.session_id}`}>
                      <AgentBadge status={agent.status} />
                      <span className="ml-1.5 truncate">{agent.name}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </SidebarMenu>
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

function AgentBadge({ status }: { status: AgentStatus }) {
  switch (status) {
    case "PROGRESSING":
      return (
        <span className="shrink-0 text-yellow-400">
          <Spinner aria-label="Provisioning" className="size-3" />
        </span>
      )
    case "WORKING":
      return (
        <span className="shrink-0 text-blue-400">
          <Spinner aria-label="Working" className="size-3" />
        </span>
      )
    case "DEGRADED":
      return (
        <span className="shrink-0 text-red-500">
          <Spinner aria-label="Degraded" className="size-3" />
        </span>
      )
    case "IDLE":
      return (
        <span
          aria-label="Idle"
          role="status"
          className="size-1.5 shrink-0 rounded-full bg-green-500"
        />
      )
    case "WAITING_FOR_HUMAN_INTERACTION":
      return (
        <span
          aria-label="Waiting"
          role="status"
          className="relative size-1.5 shrink-0 rounded-full bg-foreground"
        >
          <span className="absolute inset-0 animate-ping rounded-full bg-foreground" />
        </span>
      )
    default:
      return (
        <span
          aria-label="Unknown"
          role="status"
          className="size-1.5 shrink-0 rounded-full bg-red-500"
        />
      )
  }
}
