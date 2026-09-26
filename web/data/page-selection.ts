import "server-only"

import { cookies } from "next/headers"
import { cache } from "react"
import type {
  Agent,
  Error,
  Workflow,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSchedule,
  WorkflowSummary,
  WorkflowWebhookTrigger,
} from "@/lib/gateway/client"
import {
  readSelectionHistory,
  restoreSelection,
  selectionCookie,
  type PageSelection,
  type SelectionPage,
} from "@/lib/page-selection"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkflowCachedQuery, listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import { getWorkflowRunCachedQuery, listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { listTraceSessionFilterAction } from "@/data/lens.actions"
import type { TraceSessionFilterItem } from "@/data/types"
import type { getWorkspaceScope } from "@/data/workspaces"

type WorkspaceScope = Extract<Awaited<ReturnType<typeof getWorkspaceScope>>, { kind: "ready" }>

export type ResolvedPageSelection = {
  selected: PageSelection
  requested: PageSelection
  agents: Agent[]
  workflows: WorkflowSummary[]
  schedules: WorkflowSchedule[]
  webhookTriggers: WorkflowWebhookTrigger[]
  workflowRuns: WorkflowRunSummary[]
  workflow?: Workflow
  workflowRun?: WorkflowRunDetail
  sessions: TraceSessionFilterItem[]
  error?: Error
}

/** Reuse the request snapshot without including preferences in resource cache keys. */
export const getSelectionHistory = cache(async () => {
  const jar = await cookies()
  return readSelectionHistory(jar.get(selectionCookie)?.value)
})

/** Resolve each parent once so filters, content, and mutation targets agree. */
export async function resolvePageSelection(
  workspace: WorkspaceScope,
  page: SelectionPage,
  search: PageSelection
): Promise<ResolvedPageSelection> {
  const workspaceId = workspace.workspace.id
  const scope = JSON.stringify([
    workspace.scope.organizationSession.session.user.id,
    workspace.scope.organization.id,
    workspaceId,
  ])
  const [history, agentsResult] = await Promise.all([
    getSelectionHistory(),
    listAgentsCachedQuery(undefined, workspaceId),
  ])
  const requested = restoreSelection(history, scope, page, search)
  const state: ResolvedPageSelection = {
    selected: {},
    requested,
    agents: [],
    workflows: [],
    schedules: [],
    webhookTriggers: [],
    workflowRuns: [],
    sessions: [],
  }
  if (agentsResult.error) return { ...state, error: agentsResult.error }
  state.agents = agentsResult.agents
  if (
    requested.agent_name &&
    !state.agents.some((agent) => agent.name === requested.agent_name) &&
    agentsResult.hasNextPage
  ) {
    const result = await listAgentsCachedQuery(
      { agent_name: [requested.agent_name], limit: 1 },
      workspaceId
    )
    if (result.error) {
      if (result.error.code !== "invalid_request") return { ...state, error: result.error }
    } else {
      state.agents = [...state.agents, ...result.agents]
    }
  }
  if (page === "secrets") {
    state.agents = state.agents.filter((agent) => agent.capabilities.read_secrets)
    let pageToken = agentsResult.nextPageToken
    while (!state.agents.length && pageToken) {
      const result = await listAgentsCachedQuery({ page_token: pageToken }, workspaceId)
      if (result.error) return { ...state, error: result.error }
      state.agents = result.agents.filter((agent) => agent.capabilities.read_secrets)
      pageToken = result.nextPageToken
    }
  }
  const agent = state.agents.find((agent) => agent.name === requested.agent_name) ?? state.agents[0]
  if (!agent) return state
  state.selected.agent_name = agent.name
  // A fallback parent must not inherit descendants from the missing resource.
  const children =
    requested.agent_name !== undefined && agent.name !== requested.agent_name ? {} : requested

  if (page === "lens/traces") {
    const result = await listTraceSessionFilterAction(
      agent.name,
      workspaceId,
      workspace.workspace.type
    )
    if (result.error) return { ...state, error: result.error }
    state.sessions = result.data
    state.selected.session_id = (
      state.sessions.find((session) => session.sessionId === children.session_id) ??
      state.sessions[0]
    )?.sessionId
    return state
  }

  if (page === "workflows/triggers" || page === "workflows/triggers/runs") {
    state.selected.type = children.type === "webhook" ? "webhook" : "schedule"
    if (page === "workflows/triggers") return state

    const triggerSelection =
      children.type !== undefined && children.type !== state.selected.type ? {} : children
    if (state.selected.type === "webhook") {
      let pageToken: string | undefined
      do {
        const result = await listWorkflowWebhookTriggersCachedQuery(agent.name, workspaceId, {
          limit: 200,
          page_token: pageToken,
        })
        if (result.error) return { ...state, error: result.error }
        state.webhookTriggers.push(...result.webhookTriggers)
        pageToken = result.nextPageToken || undefined
      } while (
        pageToken &&
        triggerSelection.workflow_name &&
        triggerSelection.webhook_api_key_id &&
        !state.webhookTriggers.some(
          (trigger) =>
            trigger.workflow_name === triggerSelection.workflow_name &&
            trigger.api_key_id === triggerSelection.webhook_api_key_id
        )
      )
      const trigger =
        state.webhookTriggers.find(
          (trigger) =>
            trigger.workflow_name === triggerSelection.workflow_name &&
            trigger.api_key_id === triggerSelection.webhook_api_key_id
        ) ?? state.webhookTriggers[0]
      state.selected.workflow_name = trigger?.workflow_name
      state.selected.webhook_api_key_id = trigger?.api_key_id
      return state
    }

    let pageToken: string | undefined
    do {
      const result = await listWorkflowSchedulesCachedQuery(agent.name, workspaceId, {
        limit: 200,
        page_token: pageToken,
      })
      if (result.error) return { ...state, error: result.error }
      state.schedules.push(...result.workflowSchedules)
      pageToken = result.nextPageToken || undefined
    } while (
      pageToken &&
      triggerSelection.schedule_name &&
      !state.schedules.some((schedule) => schedule.name === triggerSelection.schedule_name)
    )
    const schedule =
      state.schedules.find((schedule) => schedule.name === triggerSelection.schedule_name) ??
      state.schedules[0]
    state.selected.schedule_name = schedule?.name
    state.selected.workflow_name = schedule?.workflow_name
    return state
  }

  if (
    page !== "workflows/graphs" &&
    page !== "workflows/evaluations" &&
    page !== "workflows/runs" &&
    page !== "workflows/triggers/runs/graph"
  )
    return state
  const workflows = await listWorkflowSummariesCachedQuery(agent.name, workspaceId)
  if (workflows.error) return { ...state, error: workflows.error }
  state.workflows = workflows.summaries
  let workflow =
    state.workflows.find((workflow) => workflow.workflow_name === children.workflow_name) ??
    state.workflows[0]
  let runName = children.run_name
  // A resource can disappear after its options were listed. Retry one fallback,
  // then surface a persistent error rather than chasing a changing dataset.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!workflow) return state
    const workflowName = workflow.workflow_name
    if (page === "workflows/triggers/runs/graph" && state.selected.workflow_name !== workflowName) {
      if (children.workflow_name !== undefined && workflowName !== children.workflow_name)
        runName = undefined
      const runs = await listWorkflowRunsCachedQuery(agent.name, workflowName, workspaceId, {
        limit: 200,
      })
      if (runs.error) return { ...state, error: runs.error }
      state.workflowRuns = runs.workflowRuns
      if (runName && !state.workflowRuns.some((run) => run.name === runName) && runs.hasNextPage) {
        const result = await getWorkflowRunCachedQuery(
          agent.name,
          workflowName,
          runName,
          workspaceId
        )
        if (
          result.error &&
          result.error.code !== "not_found" &&
          result.error.code !== "invalid_request"
        )
          return { ...state, error: result.error }
        if (result.workflowRun) state.workflowRuns = [...state.workflowRuns, result.workflowRun]
      }
    }
    state.selected.workflow_name = workflowName
    const run = state.workflowRuns.find((run) => run.name === runName) ?? state.workflowRuns[0]
    state.selected.run_name = run?.name
    if (page === "workflows/triggers/runs/graph" && !run) return state
    const [detail, runDetail] = await Promise.all([
      getWorkflowCachedQuery(agent.name, workflowName, workspaceId),
      run ? getWorkflowRunCachedQuery(agent.name, workflowName, run.name, workspaceId) : undefined,
    ])
    if (detail.error?.code === "not_found" && attempt === 0) {
      state.workflows = state.workflows.filter((item) => item.workflow_name !== workflowName)
      workflow = state.workflows[0]
      state.selected.workflow_name = undefined
      state.selected.run_name = undefined
      state.workflowRuns = []
      runName = undefined
      continue
    }
    if (detail.error) return { ...state, error: detail.error }
    if (runDetail?.error?.code === "not_found" && attempt === 0) {
      state.workflowRuns = state.workflowRuns.filter((item) => item.name !== run?.name)
      state.selected.run_name = undefined
      runName = undefined
      continue
    }
    if (runDetail?.error) return { ...state, error: runDetail.error }
    state.workflow = detail.workflow
    state.workflowRun = runDetail?.workflowRun
    return state
  }
  return state
}
