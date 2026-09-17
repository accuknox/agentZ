import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import * as z from "zod"
import { Skeleton } from "@/components/ui/skeleton"
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
import { resolvePageSelection, type ResolvedPageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import type { WorkflowActionScope } from "@/data/types"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { NewScheduleButton } from "./new-schedule-button"
import { TriggersFilters } from "./triggers-filters"
import { ScheduleTriggersTable } from "./triggers-table"
import { WebhookTriggersTable, type WebhookTriggerRow } from "./webhook-triggers-table"
import { searchParamStringSchema } from "@/lib/search-params"

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

type ResolvedSearchParams = z.output<typeof workflowTriggersSearchParamsSchema>

export default function TriggersPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceTriggers {...props} />
    </Suspense>
  )
}

async function WorkspaceTriggers({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers">) {
  const [route, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (workspace.kind !== "ready" || workspace.workspace.type === "coding") {
    notFound()
  }
  const parsed = workflowTriggersSearchParamsSchema.parse(search)
  const selection = resolvePageSelection(workspace, "workflows/triggers", parsed)
  const actionScope: WorkflowActionScope = {
    basePath: `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}`,
    workspaceId: workspace.workspace.id,
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <AdministrationPageHeader
        actions={
          <Suspense fallback={<Skeleton className="h-9 w-44 rounded-md" />}>
            <HeaderAction actionScope={actionScope} selection={selection} />
          </Suspense>
        }
        title="Triggers"
      />
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters selection={selection} />
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <Triggers actionScope={actionScope} searchParams={parsed} selection={selection} />
      </Suspense>
    </main>
  )
}

async function Filters({ selection }: { selection: Promise<ResolvedPageSelection> }) {
  const state = await selection
  if (state.error) return <ErrorPanel message={state.error.message} />
  return (
    <>
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <TriggersFilters
        agents={state.agents}
        selectedAgentName={state.selected.agent_name}
        selectedType={state.selected.type ?? "schedule"}
      />
    </>
  )
}

async function Triggers({
  actionScope,
  searchParams,
  selection,
}: {
  actionScope: WorkflowActionScope
  searchParams: ResolvedSearchParams
  selection: Promise<ResolvedPageSelection>
}) {
  const { selected, requested, error } = await selection
  if (error) return <ErrorPanel message={error.message} />
  if (!selected.agent_name) return <EmptyState message="No agents available" />
  const selectedType = selected.type
  const pageToken =
    selected.agent_name === requested.agent_name && selected.type === requested.type
      ? searchParams.page_token
      : undefined

  if (selectedType === "webhook") {
    const triggersResult = await listWorkflowWebhookTriggersCachedQuery(
      selected.agent_name,
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
        agentName={selected.agent_name}
        basePath={actionScope.basePath}
        hasNextPage={triggersResult.hasNextPage}
        nextPageToken={triggersResult.nextPageToken}
        rows={rows}
      />
    )
  }

  const schedulesResult = await listWorkflowSchedulesCachedQuery(
    selected.agent_name,
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
    selected.agent_name,
    actionScope.workspaceId
  )
  const workflows = workflowsResult.error ? [] : workflowsResult.summaries

  return (
    <ScheduleTriggersTable
      key={selected.agent_name}
      agentName={selected.agent_name}
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
  selection,
}: {
  actionScope: WorkflowActionScope
  selection: Promise<ResolvedPageSelection>
}) {
  const { selected, error } = await selection
  if (error || !selected.agent_name || selected.type === "webhook") return null

  const workflowsResult = await listWorkflowSummariesCachedQuery(
    selected.agent_name,
    actionScope.workspaceId
  )
  return (
    <NewScheduleButton
      key={selected.agent_name}
      agentName={selected.agent_name}
      createWorkflowScheduleAction={createWorkflowScheduleFormAction.bind(null, actionScope)}
      getWorkflowInputContractAction={getWorkflowInputContractAction.bind(null, actionScope)}
      workflows={workflowsResult.error ? [] : workflowsResult.summaries}
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

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert className="px-6" variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}
