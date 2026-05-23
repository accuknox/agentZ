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
  "use cache"

  cacheLife("minutes")
  cacheTag(agentWorkflowsTag(agentName))

  const result = await listWorkflowSummaries({ path: { agentName } })
  if (result.error) {
    return {
      summaries: undefined,
      error: result.error,
    }
  }

  return {
    summaries: result.data,
    error: undefined,
  } satisfies WorkflowSummariesQueryResult
}

export async function getWorkflowCachedQuery(
  agentName: GetWorkflowData["path"]["agentName"],
  workflowName: GetWorkflowData["path"]["workflowName"]
): Promise<WorkflowQueryResult> {
  "use cache"

  cacheLife("minutes")
  cacheTag(agentWorkflowsTag(agentName))
  cacheTag(workflowTag(agentName, workflowName))

  const result = await getWorkflow({
    path: {
      agentName,
      workflowName,
    },
  })
  if (result.error) {
    return {
      workflow: undefined,
      error: result.error,
    }
  }

  return {
    workflow: result.data,
    error: undefined,
  } satisfies WorkflowQueryResult
}
