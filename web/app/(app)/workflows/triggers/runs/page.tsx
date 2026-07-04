import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWebhookAPIKeyDisplaysCachedQuery } from "@/data/api-key.queries"
import { selectWorkflowRunsFiltersAction } from "@/data/workflow.actions"
import { deleteWorkflowRunAction } from "@/data/workflow-run.actions"
import { listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import { RunsFilters } from "./runs-filters"
import { RunsTable } from "./runs-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

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

type SearchParams = {
  agent_name?: SearchParamStringInput
  type?: SearchParamStringInput
  workflow_name?: SearchParamStringInput
  schedule_name?: SearchParamStringInput
  webhook_api_key_id?: SearchParamStringInput
  page_token?: SearchParamStringInput
}

type ResolvedSearchParams = z.output<typeof workflowRunsSearchParamsSchema>

export default async function WorkflowRunsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = workflowRunsSearchParamsSchema.parse(await searchParams)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Workflow Runs</h1>
        </div>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={params} />
      </Suspense>
      <Suspense fallback={<RunsTableSkeleton />}>
        <Runs searchParams={params} />
      </Suspense>
    </main>
  )
}

async function Filters({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  const requestedWorkflowName = searchParams.workflow_name
  const requestedScheduleName = searchParams.schedule_name
  const requestedWebhookAPIKeyID = searchParams.webhook_api_key_id
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === requestedAgentName) ?? agentsResult.agents[0]
  if (!selectedAgent) {
    return (
      <RunsFilters
        action={selectWorkflowRunsFiltersAction}
        agents={agentsResult.agents}
        schedules={[]}
        selectedAgentName={undefined}
        selectedType={selectedType}
        webhookTriggers={[]}
      />
    )
  }

  if (selectedType === "webhook") {
    const triggersResult = await listWorkflowWebhookTriggersCachedQuery(selectedAgent.name, {
      limit: 200,
    })
    if (triggersResult.error) {
      return <ErrorPanel message={triggersResult.error.message} />
    }

    const webhookKeyDisplaysByID = await listWebhookAPIKeyDisplaysCachedQuery()

    const selectedTrigger =
      triggersResult.webhookTriggers.find(
        (trigger) =>
          trigger.workflow_name === requestedWorkflowName &&
          trigger.api_key_id === requestedWebhookAPIKeyID
      ) ?? triggersResult.webhookTriggers[0]

    return (
      <RunsFilters
        key={`${selectedAgent.name}:webhook:${selectedTrigger?.workflow_name ?? ""}:${selectedTrigger?.api_key_id ?? ""}`}
        action={selectWorkflowRunsFiltersAction}
        agents={agentsResult.agents}
        schedules={[]}
        selectedAgentName={selectedAgent.name}
        selectedType="webhook"
        selectedWebhookAPIKeyID={selectedTrigger?.api_key_id}
        selectedWorkflowName={selectedTrigger?.workflow_name}
        webhookTriggers={triggersResult.webhookTriggers.map((trigger) => {
          const apiKey = webhookKeyDisplaysByID[trigger.api_key_id]
          return {
            apiKeyId: trigger.api_key_id,
            label: `${trigger.workflow_name} - ${apiKey?.name || apiKey?.display || "Deleted key"}`,
            workflowName: trigger.workflow_name,
          }
        })}
      />
    )
  }

  const schedulesResult = await listWorkflowSchedulesCachedQuery(selectedAgent.name, {
    limit: 200,
  })
  if (schedulesResult.error) {
    return <ErrorPanel message={schedulesResult.error.message} />
  }

  const selectedSchedule =
    schedulesResult.workflowSchedules.find((schedule) => schedule.name === requestedScheduleName) ??
    schedulesResult.workflowSchedules[0]

  return (
    <RunsFilters
      key={`${selectedAgent.name}:schedule:${selectedSchedule?.name ?? ""}`}
      action={selectWorkflowRunsFiltersAction}
      agents={agentsResult.agents}
      schedules={schedulesResult.workflowSchedules}
      selectedAgentName={selectedAgent.name}
      selectedScheduleName={selectedSchedule?.name}
      selectedType="schedule"
      selectedWorkflowName={selectedSchedule?.workflow_name}
      webhookTriggers={[]}
    />
  )
}

async function Runs({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  const requestedWorkflowName = searchParams.workflow_name
  const requestedScheduleName = searchParams.schedule_name
  const requestedWebhookAPIKeyID = searchParams.webhook_api_key_id
  const pageToken = searchParams.page_token
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents?.find((agent) => agent.name === requestedAgentName) ??
    agentsResult.agents?.[0]
  if (!selectedAgent) {
    return <ErrorPanel message="No agents available" />
  }

  if (selectedType === "webhook") {
    const triggersResult = await listWorkflowWebhookTriggersCachedQuery(selectedAgent.name, {
      limit: 200,
    })
    if (triggersResult.error || !triggersResult.webhookTriggers) {
      return (
        <ErrorPanel message={triggersResult.error?.message ?? "Unable to load webhook triggers"} />
      )
    }

    const selectedTrigger =
      triggersResult.webhookTriggers.find(
        (trigger) =>
          trigger.workflow_name === requestedWorkflowName &&
          trigger.api_key_id === requestedWebhookAPIKeyID
      ) ?? triggersResult.webhookTriggers[0]
    if (!selectedTrigger) {
      return <EmptyState message="No webhook-triggered workflow runs available" />
    }

    const result = await listWorkflowRunsCachedQuery(
      selectedAgent.name,
      selectedTrigger.workflow_name,
      {
        limit: 25,
        page_token: pageToken,
        trigger_type: "Webhook",
        webhook_api_key_id: selectedTrigger.api_key_id,
      }
    )
    if (result.error) {
      return <ErrorPanel message={result.error.message} />
    }

    return (
      <RunsTable
        agentName={selectedAgent.name}
        deleteWorkflowRunAction={deleteWorkflowRunAction}
        hasNextPage={result.hasNextPage}
        nextPageToken={result.nextPageToken}
        workflowName={selectedTrigger.workflow_name}
        workflowRuns={result.workflowRuns}
      />
    )
  }

  const schedulesResult = await listWorkflowSchedulesCachedQuery(selectedAgent.name, { limit: 200 })
  if (schedulesResult.error || !schedulesResult.workflowSchedules) {
    return <ErrorPanel message={schedulesResult.error?.message ?? "Unable to load schedules"} />
  }

  const selectedSchedule =
    schedulesResult.workflowSchedules.find((schedule) => schedule.name === requestedScheduleName) ??
    schedulesResult.workflowSchedules[0]
  if (!selectedSchedule) {
    return <EmptyState message="No scheduled workflow runs available" />
  }

  const result = await listWorkflowRunsCachedQuery(
    selectedAgent.name,
    selectedSchedule.workflow_name,
    {
      limit: 25,
      page_token: pageToken,
      schedule_name: selectedSchedule.name,
      trigger_type: "Schedule",
    }
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <RunsTable
      agentName={selectedAgent.name}
      deleteWorkflowRunAction={deleteWorkflowRunAction}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      workflowName={selectedSchedule.workflow_name}
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
