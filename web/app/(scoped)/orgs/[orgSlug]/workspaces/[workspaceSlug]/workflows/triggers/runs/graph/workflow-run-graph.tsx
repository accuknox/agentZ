"use client"

import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import Workflow from "@/components/blocks/workflow/workflow"
import {
  watchWorkflowRuns,
  type WatchWorkflowRunsResponse,
  type Workflow as WorkflowDefinition,
  type WorkflowRunDetail,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

type WorkflowRunGraphProps = {
  agentName: string
  workflow: WorkflowDefinition
  workflowRun: WorkflowRunDetail
  workspaceId: string
}

export function WorkflowRunGraph({ agentName, workflow, workflowRun, workspaceId }: WorkflowRunGraphProps) {
  const query = useQuery(
    queryOptions({
      placeholderData: workflowRun,
      queryFn: streamedQuery<
        WatchWorkflowRunsResponse,
        WorkflowRunDetail,
        readonly ["watchWorkflowRunGraph", string, string, string, string]
      >({
        initialValue: workflowRun,
        reducer: (current, event) => {
          return event.workflow_runs.find((run) => run.name === workflowRun.name) ?? current
        },
        refetchMode: "reset",
        streamFn: async ({ signal }) => {
          const result = await watchWorkflowRuns({
            baseUrl: await getGatewayBaseURL(),
            body: {
              run_names: [workflowRun.name],
            },
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: {
              agentName,
              workflowName: workflow.workflow_name,
            },
            signal,
          })

          return result.stream
        },
      }),
      queryKey: [
        "watchWorkflowRunGraph",
        workspaceId,
        agentName,
        workflow.workflow_name,
        workflowRun.name,
      ],
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: true,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      staleTime: Infinity,
    })
  )

  return <Workflow key={workflowRun.name} workflow={workflow} run={query.data ?? workflowRun} />
}
