import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import * as z from "zod"
import { Skeleton } from "@/components/ui/skeleton"
import { listWebhookAPIKeyDisplaysCachedQuery } from "@/data/api-key.queries"
import { resolvePageSelection, type ResolvedPageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import type { WorkflowActionScope } from "@/data/types"
import { deleteWorkflowRunAction } from "@/data/workflow-run.actions"
import { listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { RunsFilters } from "./runs-filters"
import { RunsTable } from "./runs-table"
import { searchParamStringSchema } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Workflow Runs",
}

const workflowRunsSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  type: searchParamStringSchema,
  workflow_name: searchParamStringSchema,
  schedule_name: searchParamStringSchema,
  webhook_api_key_id: searchParamStringSchema,
  page_token: searchParamStringSchema,
})

type ResolvedSearchParams = z.output<typeof workflowRunsSearchParamsSchema>

export default function WorkflowRunsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers/runs">
) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <AdministrationPageHeader title="Workflow runs" />
      <Suspense
        fallback={
          <>
            <FiltersSkeleton />
            <RunsTableSkeleton />
          </>
        }
      >
        <WorkflowRunsContent {...props} />
      </Suspense>
    </main>
  )
}

async function WorkflowRunsContent({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers/runs">) {
  const [route, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (workspace.kind !== "ready" || workspace.workspace.type === "coding") {
    notFound()
  }
  const parsed = workflowRunsSearchParamsSchema.parse(search)
  const selection = resolvePageSelection(workspace, "workflows/triggers/runs", parsed)
  const actionScope: WorkflowActionScope = {
    basePath: `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}`,
    workspaceId: workspace.workspace.id,
  }

  return (
    <>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters workspaceId={workspace.workspace.id} selection={selection} />
      </Suspense>
      <Suspense fallback={<RunsTableSkeleton />}>
        <Runs actionScope={actionScope} searchParams={parsed} selection={selection} />
      </Suspense>
    </>
  )
}

async function Filters({
  workspaceId,
  selection,
}: {
  workspaceId: string
  selection: Promise<ResolvedPageSelection>
}) {
  const state = await selection
  if (state.error) return <ErrorPanel message={state.error.message} />
  const displays =
    state.selected.type === "webhook" ? await listWebhookAPIKeyDisplaysCachedQuery(workspaceId) : {}
  return (
    <>
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <RunsFilters
        agents={state.agents}
        schedules={state.schedules}
        selectedAgentName={state.selected.agent_name}
        selectedType={state.selected.type ?? "schedule"}
        selectedScheduleName={state.selected.schedule_name}
        selectedWorkflowName={state.selected.workflow_name}
        selectedWebhookAPIKeyID={state.selected.webhook_api_key_id}
        webhookTriggers={state.webhookTriggers.map((trigger) => ({
          ...trigger,
          label: `${trigger.workflow_name} - ${displays[trigger.api_key_id]?.name || displays[trigger.api_key_id]?.display || "Deleted key"}`,
        }))}
      />
    </>
  )
}

async function Runs({
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
  if (!selected.workflow_name)
    return (
      <EmptyState
        message={
          selected.type === "webhook"
            ? "No webhook-triggered workflow runs available"
            : "No scheduled workflow runs available"
        }
      />
    )
  const pageToken =
    selected.agent_name === requested.agent_name &&
    selected.type === requested.type &&
    selected.workflow_name === requested.workflow_name &&
    selected.schedule_name === requested.schedule_name &&
    selected.webhook_api_key_id === requested.webhook_api_key_id
      ? searchParams.page_token
      : undefined
  const result = await listWorkflowRunsCachedQuery(
    selected.agent_name,
    selected.workflow_name,
    actionScope.workspaceId,
    {
      limit: 25,
      page_token: pageToken,
      ...(selected.type === "webhook"
        ? { trigger_type: "Webhook", webhook_api_key_id: selected.webhook_api_key_id }
        : { trigger_type: "Schedule", schedule_name: selected.schedule_name }),
    }
  )
  if (result.error) return <ErrorPanel message={result.error.message} />
  return (
    <RunsTable
      agentName={selected.agent_name}
      workflowName={selected.workflow_name}
      basePath={actionScope.basePath}
      workspaceId={actionScope.workspaceId}
      deleteWorkflowRunAction={deleteWorkflowRunAction.bind(null, actionScope)}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      workflowRuns={result.workflowRuns}
    />
  )
}

function RunsTableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:px-6">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  )
}

function FiltersSkeleton() {
  return (
    <div className="bg-background border-b px-4 py-2 sm:px-6">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52" />
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-44 sm:min-w-40" />
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52" />
        </div>
      </div>
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
