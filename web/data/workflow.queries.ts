import { cacheLife, cacheTag } from "next/cache"
import {
  getWorkflow,
  listWorkflowSummaries,
  type Error,
  type GetWorkflowData,
  type ListWorkflowSummariesData,
  type Workflow,
  type WorkflowSummary,
} from "@/lib/gateway/client"
import { agentWorkflowsTag, workflowTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

type WorkflowSummariesQueryResult =
  | {
      summaries: WorkflowSummary[]
      error: undefined
    }
  | {
      summaries: undefined
      error: Error
    }

type WorkflowQueryResult =
  | {
      workflow: Workflow
      error: undefined
    }
  | {
      workflow: undefined
      error: Error
    }

export async function listWorkflowSummariesCachedQuery(
  agentName: ListWorkflowSummariesData["path"]["agentName"]
): Promise<WorkflowSummariesQueryResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentWorkflowsTag(agentName))

  const { data, error } = await listWorkflowSummaries({
    path: { agentName },
    client: gatewayServerClient,
  })
  if (error) {
    return {
      summaries: undefined,
      error,
    }
  }

  return {
    summaries: data,
    error: undefined,
  } satisfies WorkflowSummariesQueryResult
}

export async function getWorkflowCachedQuery(
  agentName: GetWorkflowData["path"]["agentName"],
  workflowName: GetWorkflowData["path"]["workflowName"]
): Promise<WorkflowQueryResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentWorkflowsTag(agentName))
  cacheTag(workflowTag(agentName, workflowName))

  const { data, error } = await getWorkflow({
    client: gatewayServerClient,
    path: {
      agentName,
      workflowName,
    },
  })
  if (error) {
    return {
      workflow: undefined,
      error,
    }
  }

  return {
    workflow: data,
    error: undefined,
  } satisfies WorkflowQueryResult
}
