"use client"

import { Spinner } from "@/components/ui/spinner"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  watchAgents,
  type Agent,
  type AgentStatus,
  type WatchAgentsResponse,
} from "@/lib/gateway/client"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import type { ReactElement } from "react"

type AgentReadiness = {
  isGettingReady: boolean
}

const gettingReadyStatuses = new Set<AgentStatus>(["PROGRESSING", "UNSPECIFIED", "DEGRADED"])

export function agentIsGettingReady(status: AgentStatus): boolean {
  return gettingReadyStatuses.has(status)
}

export function watchAgentsQueryOptions(workspaceId: string, initialAgents: Agent[] = []) {
  return queryOptions({
    placeholderData: initialAgents,
    queryFn: streamedQuery<WatchAgentsResponse, Agent[], ["watchAgents", string]>({
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
        const result = await watchAgents({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
        })
        return result.stream
      },
    }),
    queryKey: ["watchAgents", workspaceId],
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })
}

export function useAgentReadiness(
  agentName: string | undefined,
  workspaceId: string,
  initialStatus?: AgentStatus
): AgentReadiness {
  const { data } = useQuery({
    ...watchAgentsQueryOptions(workspaceId),
    enabled: agentName !== undefined,
    select: (agents) => agents.find((agent) => agent.name === agentName)?.status,
  })
  const status = data ?? initialStatus

  return {
    isGettingReady: status ? agentIsGettingReady(status) : false,
  }
}

export function AgentGettingReady({ className }: { className?: string }): ReactElement {
  return (
    <span className={className ?? "text-muted-foreground flex min-w-0 items-center gap-2 text-sm"}>
      <Spinner aria-hidden="true" className="size-3.5" />
      <span className="truncate">Your agent is getting ready</span>
    </span>
  )
}
