"use server"

import type { Route } from "next"
import { redirect } from "next/navigation"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import {
  workflowFiltersFormSchema,
  workflowRunGraphFiltersFormSchema,
  workflowRunFiltersFormSchema,
  workflowTriggerFiltersFormSchema,
} from "@/data/workflow.schema"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"

export type WorkflowActionScope = {
  basePath: string
  workspaceId: string
}

export async function selectWorkflowFiltersAction(scope: WorkflowActionScope, formData: FormData) {
  const agentsResult = await listAgentsCachedQuery(undefined, scope.workspaceId)
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect(workflowsPath(scope))
  }

  const parsed = workflowFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect(workflowsPath(scope))
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect(workflowsPath(scope))
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(agent.name, scope.workspaceId)
  if (workflowsResult.error || !workflowsResult.summaries) {
    redirect(workflowsPath(scope, { agentName: agent.name }))
  }

  const workflow =
    workflowsResult.summaries.find(
      (currentWorkflow) => currentWorkflow.workflow_name === parsed.data.workflow_name
    ) ?? workflowsResult.summaries[0]
  if (!workflow) {
    redirect(workflowsPath(scope, { agentName: agent.name }))
  }

  redirect(
    workflowsPath(scope, {
      agentName: agent.name,
      workflowName: workflow.workflow_name,
    })
  )
}

export async function selectWorkflowTriggerFiltersAction(
  scope: WorkflowActionScope,
  formData: FormData
) {
  const agentsResult = await listAgentsCachedQuery(undefined, scope.workspaceId)
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect(workflowTriggersPath(scope))
  }

  const parsed = workflowTriggerFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect(workflowTriggersPath(scope))
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect(workflowTriggersPath(scope))
  }

  redirect(
    workflowTriggersPath(scope, {
      agentName: agent.name,
      type: parsed.data.type,
    })
  )
}

export async function selectWorkflowRunsFiltersAction(
  scope: WorkflowActionScope,
  formData: FormData
) {
  const agentsResult = await listAgentsCachedQuery(undefined, scope.workspaceId)
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect(workflowRunsPath(scope))
  }

  const parsed = workflowRunFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect(workflowRunsPath(scope))
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect(workflowRunsPath(scope))
  }

  if (parsed.data.type === "schedule") {
    const schedulesResult = await listWorkflowSchedulesCachedQuery(agent.name, scope.workspaceId, {
      limit: 200,
    })
    if (schedulesResult.error || !schedulesResult.workflowSchedules) {
      redirect(workflowTriggersPath(scope, { agentName: agent.name, type: "schedule" }))
    }

    const schedule =
      schedulesResult.workflowSchedules.find(
        (currentSchedule) => currentSchedule.name === parsed.data.schedule_name
      ) ?? schedulesResult.workflowSchedules[0]
    if (!schedule) {
      redirect(workflowTriggersPath(scope, { agentName: agent.name, type: "schedule" }))
    }

    redirect(
      workflowRunsPath(scope, {
        agentName: agent.name,
        type: "schedule",
        workflowName: schedule.workflow_name,
        scheduleName: schedule.name,
      })
    )
  }

  const webhookTriggersResult = await listWorkflowWebhookTriggersCachedQuery(
    agent.name,
    scope.workspaceId,
    {
      limit: 200,
    }
  )
  if (webhookTriggersResult.error || !webhookTriggersResult.webhookTriggers) {
    redirect(workflowTriggersPath(scope, { agentName: agent.name, type: "webhook" }))
  }

  const webhookTrigger =
    webhookTriggersResult.webhookTriggers.find(
      (currentTrigger) =>
        currentTrigger.workflow_name === parsed.data.workflow_name &&
        currentTrigger.api_key_id === parsed.data.webhook_api_key_id
    ) ?? webhookTriggersResult.webhookTriggers[0]
  if (!webhookTrigger) {
    redirect(workflowTriggersPath(scope, { agentName: agent.name, type: "webhook" }))
  }

  redirect(
    workflowRunsPath(scope, {
      agentName: agent.name,
      type: "webhook",
      workflowName: webhookTrigger.workflow_name,
      webhookApiKeyId: webhookTrigger.api_key_id,
    })
  )
}

export async function selectWorkflowRunGraphFiltersAction(
  scope: WorkflowActionScope,
  formData: FormData
) {
  const agentsResult = await listAgentsCachedQuery(undefined, scope.workspaceId)
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect(workflowRunGraphPath(scope))
  }

  const parsed = workflowRunGraphFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect(workflowRunGraphPath(scope))
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect(workflowRunGraphPath(scope))
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(agent.name, scope.workspaceId)
  if (workflowsResult.error || !workflowsResult.summaries) {
    redirect(workflowRunGraphPath(scope, { agentName: agent.name }))
  }

  const workflow =
    workflowsResult.summaries.find(
      (currentWorkflow) => currentWorkflow.workflow_name === parsed.data.workflow_name
    ) ?? workflowsResult.summaries[0]
  if (!workflow) {
    redirect(workflowRunGraphPath(scope, { agentName: agent.name }))
  }

  const runsResult = await listWorkflowRunsCachedQuery(
    agent.name,
    workflow.workflow_name,
    scope.workspaceId,
    {
      limit: 200,
    }
  )
  if (runsResult.error || !runsResult.workflowRuns) {
    redirect(
      workflowRunGraphPath(scope, {
        agentName: agent.name,
        workflowName: workflow.workflow_name,
      })
    )
  }

  const run =
    runsResult.workflowRuns.find((currentRun) => currentRun.name === parsed.data.run_name) ??
    runsResult.workflowRuns[0]
  if (!run) {
    redirect(
      workflowRunGraphPath(scope, {
        agentName: agent.name,
        workflowName: workflow.workflow_name,
      })
    )
  }

  redirect(
    workflowRunGraphPath(scope, {
      agentName: agent.name,
      workflowName: workflow.workflow_name,
      runName: run.name,
    })
  )
}

function workflowsPath(
  scope: WorkflowActionScope,
  { agentName, workflowName }: { agentName?: string; workflowName?: string } = {}
): Route {
  const params = new URLSearchParams()
  if (agentName) {
    params.set("agent_name", agentName)
  }
  if (workflowName) {
    params.set("workflow_name", workflowName)
  }

  const query = params.toString()
  const path = `${scope.basePath}/workflows/graphs`
  return query === "" ? (path as Route) : (`${path}?${query}` as Route)
}

function workflowTriggersPath(
  scope: WorkflowActionScope,
  { agentName, type }: { agentName?: string; type?: "schedule" | "webhook" } = {}
): Route {
  const params = new URLSearchParams()
  if (agentName) {
    params.set("agent_name", agentName)
  }
  if (type) {
    params.set("type", type)
  }

  const query = params.toString()
  const path = `${scope.basePath}/workflows/triggers`
  return query === "" ? (path as Route) : (`${path}?${query}` as Route)
}

function workflowRunsPath(
  scope: WorkflowActionScope,
  input?: {
    agentName: string
    type: "schedule" | "webhook"
    workflowName: string
    scheduleName?: string
    webhookApiKeyId?: string
  }
): Route {
  const path = `${scope.basePath}/workflows/triggers/runs`
  if (!input) {
    return path as Route
  }

  const params = new URLSearchParams()
  params.set("agent_name", input.agentName)
  params.set("type", input.type)
  params.set("workflow_name", input.workflowName)
  if (input.scheduleName) {
    params.set("schedule_name", input.scheduleName)
  }
  if (input.webhookApiKeyId) {
    params.set("webhook_api_key_id", input.webhookApiKeyId)
  }

  return `${path}?${params.toString()}` as Route
}

function workflowRunGraphPath(
  scope: WorkflowActionScope,
  {
    agentName,
    workflowName,
    runName,
  }: {
    agentName?: string
    workflowName?: string
    runName?: string
  } = {}
): Route {
  const params = new URLSearchParams()
  if (agentName) {
    params.set("agent_name", agentName)
  }
  if (workflowName) {
    params.set("workflow_name", workflowName)
  }
  if (runName) {
    params.set("run_name", runName)
  }

  const query = params.toString()
  const path = `${scope.basePath}/workflows/triggers/runs/graph`
  return query === "" ? (path as Route) : (`${path}?${query}` as Route)
}
