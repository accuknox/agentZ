"use server"

import { redirect } from "next/navigation"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { workflowFiltersFormSchema } from "@/data/workflow.schema"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"

export async function selectWorkflowFiltersAction(formData: FormData) {
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect("/workflows")
  }

  const parsed = workflowFiltersFormSchema.safeParse({
    agent_name: typeof formData.get("agent_name") === "string" ? formData.get("agent_name") : "",
    workflow_name:
      typeof formData.get("workflow_name") === "string" ? formData.get("workflow_name") : "",
  })
  if (!parsed.success) {
    redirect("/workflows")
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]

  if (!agent) {
    redirect("/workflows")
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(agent.name)
  if (workflowsResult.error || !workflowsResult.summaries) {
    redirect(workflowsPath({ agentName: agent.name }))
  }

  const workflow =
    workflowsResult.summaries.find(
      (currentWorkflow) => currentWorkflow.workflow_name === parsed.data.workflow_name
    ) ?? workflowsResult.summaries[0]

  if (!workflow) {
    redirect(workflowsPath({ agentName: agent.name }))
  }

  redirect(
    workflowsPath({
      agentName: agent.name,
      workflowName: workflow.workflow_name,
    })
  )
}

function workflowsPath({ agentName, workflowName }: { agentName?: string; workflowName?: string }) {
  const params = new URLSearchParams()
  if (agentName) {
    params.set("agent_name", agentName)
  }
  if (workflowName) {
    params.set("workflow_name", workflowName)
  }

  const query = params.toString()
  return query === "" ? "/workflows" : `/workflows?${query}`
}
