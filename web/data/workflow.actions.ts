"use server"

import type { Route } from "next"
import { redirect } from "next/navigation"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import {
  workflowFiltersFormSchema,
  workflowRunFiltersFormSchema,
  workflowTriggerFiltersFormSchema,
} from "@/data/workflow.schema"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"

export async function selectWorkflowFiltersAction(formData: FormData) {
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect("/workflows/graphs")
  }

  const parsed = workflowFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect("/workflows/graphs")
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect("/workflows/graphs")
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

export async function selectWorkflowTriggerFiltersAction(formData: FormData) {
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect("/workflows/triggers")
  }

  const parsed = workflowTriggerFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect("/workflows/triggers")
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect("/workflows/triggers")
  }

  redirect(
    workflowTriggersPath({
      agentName: agent.name,
      type: parsed.data.type,
    })
  )
}

export async function selectWorkflowRunsFiltersAction(formData: FormData) {
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    redirect("/workflows/triggers/runs")
  }

  const parsed = workflowRunFiltersFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect("/workflows/triggers/runs")
  }

  const agent =
    agentsResult.agents.find((currentAgent) => currentAgent.name === parsed.data.agent_name) ??
    agentsResult.agents[0]
  if (!agent) {
    redirect("/workflows/triggers/runs")
  }

  if (parsed.data.type === "schedule") {
    const schedulesResult = await listWorkflowSchedulesCachedQuery(agent.name, {
      limit: 200,
    })
    if (schedulesResult.error || !schedulesResult.workflowSchedules) {
      redirect(workflowTriggersPath({ agentName: agent.name, type: "schedule" }))
    }

    const schedule =
      schedulesResult.workflowSchedules.find(
        (currentSchedule) => currentSchedule.name === parsed.data.schedule_name
      ) ?? schedulesResult.workflowSchedules[0]
    if (!schedule) {
      redirect(workflowTriggersPath({ agentName: agent.name, type: "schedule" }))
    }

    redirect(
      workflowRunsPath({
        agentName: agent.name,
        type: "schedule",
        workflowName: schedule.workflow_name,
        scheduleName: schedule.name,
      })
    )
  }

  const webhookTriggersResult = await listWorkflowWebhookTriggersCachedQuery(agent.name, {
    limit: 200,
  })
  if (webhookTriggersResult.error || !webhookTriggersResult.webhookTriggers) {
    redirect(workflowTriggersPath({ agentName: agent.name, type: "webhook" }))
  }

  const webhookTrigger =
    webhookTriggersResult.webhookTriggers.find(
      (currentTrigger) =>
        currentTrigger.workflow_name === parsed.data.workflow_name &&
        currentTrigger.api_key_id === parsed.data.webhook_api_key_id
    ) ?? webhookTriggersResult.webhookTriggers[0]
  if (!webhookTrigger) {
    redirect(workflowTriggersPath({ agentName: agent.name, type: "webhook" }))
  }

  redirect(
    workflowRunsPath({
      agentName: agent.name,
      type: "webhook",
      workflowName: webhookTrigger.workflow_name,
      webhookApiKeyId: webhookTrigger.api_key_id,
    })
  )
}

function workflowsPath({
  agentName,
  workflowName,
}: {
  agentName?: string
  workflowName?: string
}): Route {
  const params = new URLSearchParams()
  if (agentName) {
    params.set("agent_name", agentName)
  }
  if (workflowName) {
    params.set("workflow_name", workflowName)
  }

  const query = params.toString()
  return query === "" ? "/workflows/graphs" : (`/workflows/graphs?${query}` as Route)
}

function workflowTriggersPath({
  agentName,
  type,
}: {
  agentName?: string
  type?: "schedule" | "webhook"
}): Route {
  const params = new URLSearchParams()
  if (agentName) {
    params.set("agent_name", agentName)
  }
  if (type) {
    params.set("type", type)
  }

  const query = params.toString()
  return query === "" ? "/workflows/triggers" : (`/workflows/triggers?${query}` as Route)
}

function workflowRunsPath({
  agentName,
  type,
  workflowName,
  scheduleName,
  webhookApiKeyId,
}: {
  agentName: string
  type: "schedule" | "webhook"
  workflowName: string
  scheduleName?: string
  webhookApiKeyId?: string
}): Route {
  const params = new URLSearchParams()
  params.set("agent_name", agentName)
  params.set("type", type)
  params.set("workflow_name", workflowName)
  if (scheduleName) {
    params.set("schedule_name", scheduleName)
  }
  if (webhookApiKeyId) {
    params.set("webhook_api_key_id", webhookApiKeyId)
  }

  return `/workflows/triggers/runs?${params.toString()}` as Route
}
