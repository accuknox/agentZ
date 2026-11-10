import "server-only"

import { cookies, headers } from "next/headers"
import { cache } from "react"
import { eq } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { invalidateRoute } from "@/data/route-memory"
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
  encodeSelectionHistory,
  invalidateSelections,
  restoreSelection,
  selectionCookie,
  selectionGroups,
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
  invalid: PageSelection[]
  resolvedAt: number
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
  sessions?: TraceSessionFilterItem[]
  error?: Error
}

/** Reuse the request snapshot without including preferences in resource cache keys. */
export const getSelectionHistory = cache(async () => {
  const jar = await cookies()
  const value = jar.get(selectionCookie)?.value
  // Next decodes cookie values; the browser reader receives their encoded form.
  return readSelectionHistory(value === undefined ? undefined : encodeURIComponent(value))
})

/** Successful deletions clear this user's related choices before their next navigation. */
export async function invalidateResource(workspaceId: string, resource: PageSelection) {
  const auth = await getAuthSession()
  if (!auth) return
  const [workspace] = await getDB()
    .select({
      slug: schema.workspaces.slug,
      organizationId: schema.organizations.id,
      organizationSlug: schema.organizations.slug,
    })
    .from(schema.workspaces)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.organizationId))
    .where(eq(schema.workspaces.id, workspaceId))
  if (!workspace) return
  const scope = JSON.stringify([auth.session.user.id, workspace.organizationId, workspaceId])
  const jar = await cookies()
  const current = jar.get(selectionCookie)?.value
  const history = readSelectionHistory(
    current === undefined ? undefined : encodeURIComponent(current)
  )
  const next = encodeSelectionHistory(invalidateSelections(history, scope, [resource]))
  if (next !== encodeSelectionHistory(history))
    jar.set(selectionCookie, decodeURIComponent(next), {
      path: "/",
      maxAge: 15552000,
      sameSite: "lax",
      secure: (await headers()).get("x-forwarded-proto") === "https",
    })
  if (!resource.agent_name || resource.workflow_name) return
  let path = `/orgs/${workspace.organizationSlug}/workspaces/${workspace.slug}/agents/${encodeURIComponent(resource.agent_name)}`
  if (resource.session_id) path += `/sessions/${encodeURIComponent(resource.session_id)}`
  await invalidateRoute(path)
}

/** Resolve each parent once so filters, content, and mutation targets agree. */
export async function resolvePageSelection(
  workspace: WorkspaceScope,
  page: SelectionPage,
  search: PageSelection
): Promise<ResolvedPageSelection> {
  let [state, requestHeaders] = await Promise.all([
    resolveSelection(workspace, page, search),
    headers(),
  ])
  const url = new URL(requestHeaders.get("x-agentz-pathname") ?? "/", "http://agentz.local")
  const remembered = new Set(url.searchParams.get("__remembered")?.split(","))
  if (state.error?.code === "not_found" && state.selected.agent_name) {
    const name = state.selected.agent_name
    const result = await listAgentsCachedQuery(
      { agent_name: [name], limit: 1 },
      workspace.workspace.id
    )
    if (!result.error && !result.agents.length) {
      const invalid = { agent_name: name }
      state.invalid.push(invalid)
      if (!search.agent_name || remembered.has("agent_name")) {
        const fallback = state.agents.find((agent) => agent.name !== name)
        const previous = state
        state = fallback
          ? await resolveSelection(workspace, page, { agent_name: fallback.name })
          : { ...state, selected: {}, subject: undefined, error: undefined }
        state.requested = previous.requested
        state.invalid = fallback ? [...previous.invalid, ...state.invalid] : previous.invalid
        state.agents = state.agents.filter((agent) => agent.name !== name)
      }
    }
  }
  if (state.error?.code === "not_found" && state.selected.app_client_id) {
    const id = state.selected.app_client_id
    const result = await listLensApps({ client: getGatewayServerClient(workspace.workspace.id) })
    if (!result.error && !result.data.apps.some((app) => app.client_id === id)) {
      state.invalid.push({ app_client_id: id })
      if (!search.app_client_id || remembered.has("app_client_id")) {
        const previous = state
        // A fresh options response confirms absence; the retry cannot inherit its session.
        state = await resolveSelection(workspace, page, {})
        state.requested = previous.requested
        state.invalid = [...previous.invalid, ...state.invalid]
      }
    }
  }
  state.resolvedAt = Date.now()
  if (state.error) return state
  const groups = selectionGroups(page, state.requested)
  for (const [index, fields] of groups.entries()) {
    const missing = fields.filter(
      (field) => state.requested[field] && state.requested[field] !== state.selected[field]
    )
    if (!missing.length) continue
    const resource: PageSelection = {}
    for (const field of groups.slice(0, index + 1).flat()) {
      if (state.requested[field] !== undefined) resource[field] = state.requested[field]
    }
    // Trigger kind is a view preference, not part of a resource's identity.
    delete resource.type
    if (
      missing.some(
        (field) => field !== "type" && field !== "agent_name" && field !== "app_client_id"
      )
    ) {
      state.invalid.push(resource)
    }
    if (missing.some((field) => search[field] !== undefined && !remembered.has(field))) {
      state.error = { code: "not_found", message: "The selected resource is unavailable." }
    }
    // A missing parent's descendants have not been checked independently.
    break
  }
  return state
}

async function resolveSelection(
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
    invalid: [],
    resolvedAt: 0,
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
    if (result.error) return { ...state, error: result.error }
    state.agents = [...state.agents, ...result.agents]
  }
  if (
    requested.agent_name &&
    !agentsResult.error &&
    !state.agents.some((agent) => agent.name === requested.agent_name)
  ) {
    state.invalid.push({ agent_name: requested.agent_name })
  }
  if (
    requested.app_client_id &&
    !state.apps.some((app) => app.client_id === requested.app_client_id)
  ) {
    state.invalid.push({ app_client_id: requested.app_client_id })
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
    if (page === "lens/mcp" && app.agent_kind === "claude-desktop") {
      // Managed MCP calls omit the desktop session and tool-call IDs.
      delete state.requested.session_id
      state.sessions = undefined
      return state
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
    requested.app_client_id ||
    (requested.agent_name !== undefined && agent.name !== requested.agent_name)
      ? {}
      : requested

  if (isLens) {
    // Hosted MCP activity is agent-wide. Its transport IDs are not
    // conversations.
    if (page === "lens/mcp" && workspace.workspace.type !== "coding") {
      delete state.requested.session_id
      return state
    }
    const result = await listTraceSessionFilterAction(
      agent.name,
      workspaceId,
      workspace.workspace.type
    )
    if (result.error && page !== "lens/mcp") return { ...state, error: result.error }
    if (result.error?.code === "not_found" && page === "lens/mcp") {
      const exact = await listAgentsCachedQuery({ agent_name: [agent.name], limit: 1 }, workspaceId)
      if (!exact.error && !exact.agents.length) return { ...state, error: result.error }
    }
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
  // Bound recovery when a resource disappears after its options were listed.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!workflow) return state
    const workflowName = workflow.workflow_name
    if (page === "workflows/triggers/runs/graph" && state.selected.workflow_name !== workflowName) {
      if (children.workflow_name !== undefined && workflowName !== children.workflow_name)
        runName = undefined
      const runs = await listWorkflowRunsCachedQuery(agent.name, workflowName, workspaceId, {
        limit: 200,
      })
      if (runs.error?.code === "not_found") {
        const detail = await getWorkflowCachedQuery(agent.name, workflowName, workspaceId)
        if (detail.error?.code === "not_found") {
          state.invalid.push({ agent_name: agent.name, workflow_name: workflowName })
          state.workflows = state.workflows.filter((item) => item.workflow_name !== workflowName)
          workflow = state.workflows[0]
          state.selected.workflow_name = undefined
          state.selected.run_name = undefined
          runName = undefined
          continue
        }
      }
      if (runs.error) return { ...state, error: runs.error }
      state.workflowRuns = runs.workflowRuns
      if (runName && !state.workflowRuns.some((run) => run.name === runName) && runs.hasNextPage) {
        const result = await getWorkflowRunCachedQuery(
          agent.name,
          workflowName,
          runName,
          workspaceId
        )
        if (result.error && result.error.code !== "not_found")
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
    if (detail.error?.code === "not_found") {
      state.invalid.push({ agent_name: agent.name, workflow_name: workflowName })
      state.workflows = state.workflows.filter((item) => item.workflow_name !== workflowName)
      workflow = state.workflows[0]
      state.selected.workflow_name = undefined
      state.selected.run_name = undefined
      state.workflowRuns = []
      runName = undefined
      continue
    }
    if (detail.error) return { ...state, error: detail.error }
    if (runDetail?.error?.code === "not_found") {
      state.invalid.push({
        agent_name: agent.name,
        workflow_name: workflowName,
        run_name: run?.name,
      })
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
