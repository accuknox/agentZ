import { cacheLife, cacheTag } from "next/cache"
import { listAgentWorkflowSchedules } from "@/lib/gateway/client"
import type { Error, ListAgentWorkflowSchedulesData, WorkflowSchedule } from "@/lib/gateway/client"
import { agentWorkflowsTag, workflowsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type ListWorkflowSchedulesQueryResult =
  | {
      workflowSchedules: WorkflowSchedule[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      workflowSchedules: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export async function listWorkflowSchedulesCachedQuery(
  agentName: ListAgentWorkflowSchedulesData["path"]["agentName"],
  workspaceId: string,
  query?: ListAgentWorkflowSchedulesData["query"]
): Promise<ListWorkflowSchedulesQueryResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(workflowsTag, `${agentWorkflowsTag(agentName)}:${workspaceId}`)

  const { data, error } = await listAgentWorkflowSchedules({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { agentName },
    query,
  })
  if (error) {
    return {
      workflowSchedules: undefined,
      error,
    }
  }

  const workflowSchedules = data.workflow_schedules
  const nextPageToken = data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    workflowSchedules,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
