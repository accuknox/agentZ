import { cacheLife, cacheTag } from "next/cache"
import { listWorkflowSchedules } from "@/lib/gateway/client"
import type { Error, ListWorkflowSchedulesData, WorkflowSchedule } from "@/lib/gateway/client"
import { agentWorkflowsTag, workflowsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

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
  agentName: ListWorkflowSchedulesData["path"]["agentName"],
  query?: ListWorkflowSchedulesData["query"]
): Promise<ListWorkflowSchedulesQueryResult> {
  "use cache"

  cacheLife("minutes")
  cacheTag(workflowsTag, agentWorkflowsTag(agentName))

  const result = await listWorkflowSchedules({
    client: gatewayServerClient,
    path: { agentName },
    query,
  })
  if (result.error) {
    return {
      workflowSchedules: undefined,
      error: result.error,
    }
  }

  const workflowSchedules = result.data.workflow_schedules
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    workflowSchedules,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}
