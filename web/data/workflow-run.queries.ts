import { cacheLife, cacheTag } from "next/cache"
import { getWorkflowRun, listWorkflowRuns } from "@/lib/gateway/client"
import type {
  Error,
  GetWorkflowRunData,
  ListWorkflowRunsData,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "@/lib/gateway/client"
import { workflowRunsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

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
  workspaceId: string,
  query?: ListWorkflowRunsData["query"]
): Promise<ListWorkflowRunsQueryResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(workflowRunsTag)

  const { data, error } = await listWorkflowRuns({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: {
      agentName,
      workflowName,
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

export type GetWorkflowRunQueryResult =
  | {
      workflowRun: WorkflowRunDetail
      error: undefined
    }
  | {
      workflowRun?: undefined
      error: Error
    }

export async function getWorkflowRunCachedQuery(
  agentName: GetWorkflowRunData["path"]["agentName"],
  workflowName: GetWorkflowRunData["path"]["workflowName"],
  runName: GetWorkflowRunData["path"]["runName"],
  workspaceId: string
): Promise<GetWorkflowRunQueryResult> {
  "use cache: private"

  cacheLife("seconds")
  cacheTag(workflowRunsTag)

  const { data, error } = await getWorkflowRun({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: {
      agentName,
      workflowName,
      runName,
    },
  })
  if (error) {
    return {
      error,
    }
  }

  return {
    workflowRun: data,
    error: undefined,
  }
}
