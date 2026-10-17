import "server-only"

import { cookies } from "next/headers"
import { cache } from "react"
import type {
  Agent,
  LensApp,
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
import { listAgentsCachedQuery, listAllAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkflowCachedQuery, listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import { getWorkflowRunCachedQuery, listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { listTraceSessionFilterAction, listAppSessionsAction } from "@/data/lens.actions"
import { listLensApps } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import type { LensSubject, TraceSessionFilterItem } from "@/data/types"
import type { getWorkspaceScope } from "@/data/workspaces"

type WorkspaceScope = Extract<Awaited<ReturnType<typeof getWorkspaceScope>>, { kind: "ready" }>

export type ResolvedPageSelection = {
  workspaceId: string
  selected: PageSelection
  requested: PageSelection
  agents: Agent[]
  apps: LensApp[]
  subject?: LensSubject
  workflows: WorkflowSummary[]
  schedules: WorkflowSchedule[]
  webhookTriggers: WorkflowWebhookTrigger[]
  workflowRuns: WorkflowRunSummary[]
  workflow?: Workflow
  workflowRun?: WorkflowRunDetail
  defaultAppClientID?: string
  sessionNextPageToken?: string
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
  const isLens = page === "lens/traces" || page === "lens/mcp"
  const [history, agentsResult, appsResult] = await Promise.all([
    getSelectionHistory(),
    isLens ? listAllAgentsCachedQuery(workspaceId) : listAgentsCachedQuery(undefined, workspaceId),
    isLens ? listLensApps({ client: getGatewayServerClient(workspaceId) }) : undefined,
  ])
  const requested = restoreSelection(history, scope, page, search)
  const state: ResolvedPageSelection = {
    workspaceId,
    selected: {},
    requested,
    agents: [],
    apps: [],
    workflows: [],
    schedules: [],
    webhookTriggers: [],
    workflowRuns: [],
    sessions: [],
  }
  if (requested.agent_name && requested.app_client_id) {
    return {
      ...state,
      error: { code: "invalid_request", message: "Select an Agent or an app." },
    }
  }
  if (appsResult?.error) return { ...state, error: appsResult.error }
  state.apps = appsResult?.data.apps ?? []
  state.defaultAppClientID = history.find(
    ([key, route, saved]) =>
      key === scope &&
      route === page &&
      state.apps.some((app) => app.client_id === saved.app_client_id && !app.agent_kind)
  )?.[2].app_client_id
  if (agentsResult.error && (!isLens || search.agent_name || state.apps.length === 0)) {
    return { ...state, error: agentsResult.error }
  }
  state.agents = agentsResult.agents ?? []
  if (isLens) {
    state.agents = state.agents.toSorted((a, b) => a.name.localeCompare(b.name))
    if (search.agent_name && !state.agents.some((agent) => agent.name === search.agent_name)) {
      return { ...state, error: { code: "not_found", message: "Agent is unavailable" } }
    }
    if (search.app_client_id && !state.apps.some((app) => app.client_id === search.app_client_id)) {
      return { ...state, error: { code: "not_found", message: "App is unavailable" } }
    }
  }
  if (
    !isLens &&
    requested.agent_name &&
    agentsResult.hasNextPage &&
    !state.agents.some((agent) => agent.name === requested.agent_name)
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
  const app =
    state.apps.find((app) => app.client_id === requested.app_client_id) ??
    (state.agents.length === 0 ? state.apps[0] : undefined)
  if (app) {
    state.selected.app_client_id = app.client_id
    if (!app.agent_kind) {
      state.subject = { kind: "app", clientID: app.client_id, name: app.name }
      return state
    }
    state.subject = {
      kind: "external-agent",
      clientID: app.client_id,
      name: app.name,
      providerKind: app.agent_kind,
    }
    const rememberedSession =
      requested.app_client_id === app.client_id ? requested.session_id : undefined
    const first = await listAppSessionsAction(app.client_id, workspaceId, { limit: 50 })
    if (first.error) return { ...state, error: first.error }
    const sessions = [...first.data.sessions]
    let selected = sessions.find((session) => session.session_id === rememberedSession)
    if (!selected && rememberedSession) {
      const exact = await listAppSessionsAction(app.client_id, workspaceId, {
        session_id: rememberedSession,
      })
      if (exact.error) return { ...state, error: exact.error }
      selected = exact.data.sessions[0]
      if (selected) sessions.push(selected)
    }
    selected ??= sessions[0]
    state.sessions = sessions.map((session) => ({
      sessionId: session.session_id,
      title: session.session_id,
    }))
    state.sessionNextPageToken = first.data.next_page_token
    state.selected.session_id = selected?.session_id
    state.subject.sessionId = selected?.session_id
    return state
  }
  const agent = state.agents.find((agent) => agent.name === requested.agent_name) ?? state.agents[0]
  if (!agent) return state
  state.selected.agent_name = agent.name
  state.subject = { kind: "agent", name: agent.name }
  // A fallback parent must not inherit descendants from the missing resource.
  const children =
    requested.agent_name !== undefined && agent.name !== requested.agent_name ? {} : requested

  if (isLens) {
    const result = await listTraceSessionFilterAction(
      agent.name,
      workspaceId,
      workspace.workspace.type
    )
    if (result.error && page !== "lens/mcp") return { ...state, error: result.error }
    state.sessions = result.data ?? []
    if (result.error && children.session_id) {
      state.sessions.push({ sessionId: children.session_id, title: children.session_id })
    }
    state.selected.session_id = (
      state.sessions.find((session) => session.sessionId === children.session_id) ??
      state.sessions[0]
    )?.sessionId
    state.subject.sessionId = state.selected.session_id
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
