import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import * as z from "zod"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWebhookAPIKeyDisplaysCachedQuery } from "@/data/api-key.queries"
import { triggerWorkflowRunAction } from "@/data/workflow-run.actions"
import {
  createWorkflowScheduleFormAction,
  deleteWorkflowScheduleFormAction,
  getWorkflowInputContractAction,
  updateWorkflowScheduleFormAction,
} from "@/data/workflow-schedule.actions"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import {
  selectWorkflowTriggerFiltersAction,
  type WorkflowActionScope,
} from "@/data/workflow.actions"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { NewScheduleButton } from "./new-schedule-button"
import { TriggersFilters } from "./triggers-filters"
import { ScheduleTriggersTable } from "./triggers-table"
import { WebhookTriggersTable, type WebhookTriggerRow } from "./webhook-triggers-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Workflow Triggers",
}

const workflowTriggersSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  type: searchParamStringSchema,
  page_token: searchParamStringSchema,
  sort_by: searchParamStringSchema.pipe(
    z.enum(["name", "workflow_name", "schedule", "created_at"]).default("created_at")
  ),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("desc")),
})

type SearchParams = {
  agent_name?: SearchParamStringInput
  type?: SearchParamStringInput
  page_token?: SearchParamStringInput
  sort_by?: SearchParamStringInput
  sort_order?: SearchParamStringInput
}

type ResolvedSearchParams = z.output<typeof workflowTriggersSearchParamsSchema>

export default async function TriggersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<SearchParams>
}) {
  const [route, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (workspace.kind !== "ready") {
    notFound()
  }
  const parsed = workflowTriggersSearchParamsSchema.parse(search)
  const actionScope: WorkflowActionScope = {
    basePath: `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}`,
    workspaceId: workspace.workspace.id,
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Triggers</h1>
        </div>
        <Suspense fallback={<HeaderButtonSkeleton />}>
          <HeaderAction actionScope={actionScope} searchParams={parsed} />
        </Suspense>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters actionScope={actionScope} searchParams={parsed} />
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <Triggers actionScope={actionScope} searchParams={parsed} />
      </Suspense>
    </main>
  )
}

async function Filters({
  actionScope,
  searchParams,
}: {
  actionScope: WorkflowActionScope
  searchParams: ResolvedSearchParams
}) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  const agentsResult = await listAgentsCachedQuery(undefined, actionScope.workspaceId)
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === requestedAgentName) ?? agentsResult.agents[0]
  if (!selectedAgent) {
    return (
      <TriggersFilters
        action={selectWorkflowTriggerFiltersAction.bind(null, actionScope)}
        agents={agentsResult.agents}
        selectedAgentName={undefined}
        selectedType={selectedType}
      />
    )
  }

  return (
    <TriggersFilters
      key={`${selectedAgent.name}:${selectedType}`}
      action={selectWorkflowTriggerFiltersAction.bind(null, actionScope)}
      agents={agentsResult.agents}
      selectedAgentName={selectedAgent.name}
      selectedType={selectedType}
    />
  )
}

async function Triggers({
  actionScope,
  searchParams,
}: {
  actionScope: WorkflowActionScope
  searchParams: ResolvedSearchParams
}) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  const pageToken = searchParams.page_token
  const agentsResult = await listAgentsCachedQuery(undefined, actionScope.workspaceId)
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents?.find((agent) => agent.name === requestedAgentName) ??
    agentsResult.agents?.[0]
  if (!selectedAgent) {
    return <EmptyState message="No agents available" />
  }

  if (selectedType === "webhook") {
    const triggersResult = await listWorkflowWebhookTriggersCachedQuery(
      selectedAgent.name,
      actionScope.workspaceId,
      { limit: 50, page_token: pageToken }
    )
    if (triggersResult.error) {
      return <ErrorPanel message={triggersResult.error.message} />
    }

    const webhookKeyDisplaysByID = await listWebhookAPIKeyDisplaysCachedQuery(
      actionScope.workspaceId
    )

    const rows: WebhookTriggerRow[] = triggersResult.webhookTriggers.map((trigger) => {
      const apiKey = webhookKeyDisplaysByID[trigger.api_key_id]
      return {
        apiKeyID: trigger.api_key_id,
        apiKeyDisplay: apiKey?.display || "Deleted key",
        apiKeyName: apiKey?.name,
        deleted: !apiKey,
        lastTriggeredAt: trigger.last_triggered_at,
        workflowName: trigger.workflow_name,
      }
    })

    return (
      <WebhookTriggersTable
        agentName={selectedAgent.name}
        basePath={actionScope.basePath}
        hasNextPage={triggersResult.hasNextPage}
        nextPageToken={triggersResult.nextPageToken}
        rows={rows}
      />
    )
  }

  const schedulesResult = await listWorkflowSchedulesCachedQuery(
    selectedAgent.name,
    actionScope.workspaceId,
    {
      limit: 50,
      page_token: pageToken,
      sort_by: searchParams.sort_by,
      sort_order: searchParams.sort_order,
    }
  )
  if (schedulesResult.error) {
    return <ErrorPanel message={schedulesResult.error.message} />
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(
    selectedAgent.name,
    actionScope.workspaceId
  )
  const workflows = workflowsResult.error ? [] : (workflowsResult.summaries ?? [])

  return (
    <ScheduleTriggersTable
      key={selectedAgent.name}
      agentName={selectedAgent.name}
      basePath={actionScope.basePath}
      deleteWorkflowScheduleAction={deleteWorkflowScheduleFormAction.bind(null, actionScope)}
      getWorkflowInputContractAction={getWorkflowInputContractAction.bind(null, actionScope)}
      hasNextPage={schedulesResult.hasNextPage}
      nextPageToken={schedulesResult.nextPageToken}
      sortBy={searchParams.sort_by}
      sortOrder={searchParams.sort_order}
      triggerWorkflowRunAction={triggerWorkflowRunAction.bind(null, actionScope)}
      updateWorkflowScheduleAction={updateWorkflowScheduleFormAction.bind(null, actionScope)}
      workflowSchedules={schedulesResult.workflowSchedules}
      workflows={workflows}
    />
  )
}

async function HeaderAction({
  actionScope,
  searchParams,
}: {
  actionScope: WorkflowActionScope
  searchParams: ResolvedSearchParams
}) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  if (selectedType === "webhook") {
    return null
  }

  const agentsResult = await listAgentsCachedQuery(undefined, actionScope.workspaceId)
  if (agentsResult.error) {
    return null
  }

  const selectedAgent =
    agentsResult.agents?.find((agent) => agent.name === requestedAgentName) ??
    agentsResult.agents?.[0]
  if (!selectedAgent) {
    return null
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(
    selectedAgent.name,
    actionScope.workspaceId
  )
  return (
    <NewScheduleButton
      key={selectedAgent.name}
      agentName={selectedAgent.name}
      createWorkflowScheduleAction={createWorkflowScheduleFormAction.bind(null, actionScope)}
      getWorkflowInputContractAction={getWorkflowInputContractAction.bind(null, actionScope)}
      workflows={workflowsResult.error ? [] : (workflowsResult.summaries ?? [])}
    />
  )
}

function FiltersSkeleton() {
  return (
    <div className="bg-background border-b px-4 py-2 sm:px-6">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52" />
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-44 sm:min-w-40" />
        </div>
      </div>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  )
}

function HeaderButtonSkeleton() {
  return <Skeleton className="h-9 w-44 rounded-md" />
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="bg-destructive/5 text-destructive m-6 rounded-md p-4 text-sm">{message}</div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}
