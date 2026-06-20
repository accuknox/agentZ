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
  workflowName: ListWorkflowRunsData["path"]["workflowName"],
  scheduleName: ListWorkflowRunsData["path"]["scheduleName"],
  query?: ListWorkflowRunsData["query"]
): Promise<ListWorkflowRunsQueryResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(workflowRunsTag, scheduleWorkflowRunsTag(agentName, scheduleName))

  const { data, error } = await listWorkflowRuns({
    client: gatewayServerClient,
    path: {
      agentName,
      workflowName,
      scheduleName,
    },
    query,
  })
  if (error) {
    return {
      workflowRuns: undefined,
      error,
    }
  }

  const workflowRuns = data.workflow_runs
  const nextPageToken = data.next_page_token

  return {
    workflowRuns,
    nextPageToken,
    hasNextPage: nextPageToken.length > 0,
    error: undefined,
  }
}
