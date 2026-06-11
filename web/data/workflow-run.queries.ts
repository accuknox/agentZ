import { cacheLife, cacheTag } from "next/cache"
import { listWorkflowRuns } from "@/lib/gateway/client"
import type { Error, ListWorkflowRunsData, WorkflowRunSummary } from "@/lib/gateway/client"
import { scheduleWorkflowRunsTag, workflowRunsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

export type ListWorkflowRunsQueryResult =
  | {
      workflowRuns: WorkflowRunSummary[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      workflowRuns: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export async function listWorkflowRunsCachedQuery(
  agentName: ListWorkflowRunsData["path"]["agentName"],
  scheduleName: ListWorkflowRunsData["path"]["name"],
  query?: ListWorkflowRunsData["query"]
): Promise<ListWorkflowRunsQueryResult> {
  "use cache"

  cacheLife("minutes")
  cacheTag(workflowRunsTag, scheduleWorkflowRunsTag(agentName, scheduleName))

  const result = await listWorkflowRuns({
    client: gatewayServerClient,
    path: {
      agentName,
      name: scheduleName,
    },
    query,
  })
  if (result.error) {
    return {
      workflowRuns: undefined,
      error: result.error,
    }
  }

  const workflowRuns = result.data.workflow_runs
  const nextPageToken = result.data.next_page_token

  return {
    workflowRuns,
    nextPageToken,
    hasNextPage: nextPageToken.length > 0,
    error: undefined,
  }
}
