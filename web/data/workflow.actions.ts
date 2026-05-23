"use server"

import { redirect } from "next/navigation"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"

export async function selectWorkflowFiltersAction(formData: FormData) {
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect("/workflows")
  }

  const requestedAgentName = formData.get("agent_name")
  const requestedWorkflowName = formData.get("workflow_name")

  const selectedAgent =
    typeof requestedAgentName === "string"
      ? agentsResult.agents.find((agent) => agent.name === requestedAgentName)
      : undefined
  const agentName = selectedAgent?.name ?? agentsResult.agents[0]?.name

  if (!agentName) {
    redirect("/workflows")
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(agentName)
  if (workflowsResult.error || !workflowsResult.summaries) {
    redirect(`/workflows?agent_name=${encodeURIComponent(agentName)}`)
  }

  const selectedWorkflow =
    typeof requestedWorkflowName === "string"
      ? workflowsResult.summaries.find(
          (workflow) => workflow.workflow_name === requestedWorkflowName
        )
      : undefined
  const workflowName =
    selectedWorkflow?.workflow_name ?? workflowsResult.summaries[0]?.workflow_name

  if (!workflowName) {
    redirect(`/workflows?agent_name=${encodeURIComponent(agentName)}`)
  }

  redirect(
    `/workflows?agent_name=${encodeURIComponent(agentName)}&workflow_name=${encodeURIComponent(workflowName)}`
  )
}
