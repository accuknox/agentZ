import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import * as z from "zod"
import { Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWebhookAPIKeyDisplaysCachedQuery } from "@/data/api-key.queries"
import { triggerWorkflowRunAction } from "@/data/workflow-run.actions"
import {
  createWorkflowScheduleFormAction,
  deleteWorkflowScheduleFormAction,
  getWorkflowInputSchemaAction,
  updateWorkflowScheduleFormAction,
} from "@/data/workflow-schedule.actions"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowWebhookTriggersCachedQuery } from "@/data/workflow-trigger.queries"
import { selectWorkflowTriggerFiltersAction } from "@/data/workflow.actions"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
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
})

type SearchParams = {
  agent_name?: SearchParamStringInput
  type?: SearchParamStringInput
  page_token?: SearchParamStringInput
}

type ResolvedSearchParams = z.output<typeof workflowTriggersSearchParamsSchema>

export default async function TriggersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = workflowTriggersSearchParamsSchema.parse(await searchParams)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Triggers</h1>
        </div>
        <Suspense fallback={<HeaderButtonSkeleton />}>
          <HeaderAction searchParams={params} />
        </Suspense>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={params} />
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <Triggers searchParams={params} />
      </Suspense>
    </main>
  )
}

async function Filters({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === requestedAgentName) ?? agentsResult.agents[0]
  if (!selectedAgent) {
    return (
      <TriggersFilters
        action={selectWorkflowTriggerFiltersAction}
        agents={agentsResult.agents}
        selectedAgentName={undefined}
        selectedType={selectedType}
      />
    )
  }

  return (
    <TriggersFilters
      key={`${selectedAgent.name}:${selectedType}`}
      action={selectWorkflowTriggerFiltersAction}
      agents={agentsResult.agents}
      selectedAgentName={selectedAgent.name}
      selectedType={selectedType}
    />
  )
}

async function Triggers({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  const pageToken = searchParams.page_token
  const agentsResult = await listAgentsCachedQuery()
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
    const triggersResult = await listWorkflowWebhookTriggersCachedQuery(selectedAgent.name, {
      limit: 50,
      page_token: pageToken,
    })
    if (triggersResult.error) {
      return <ErrorPanel message={triggersResult.error.message} />
    }

    const webhookKeyDisplaysByID = await listWebhookAPIKeyDisplaysCachedQuery()

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
        hasNextPage={triggersResult.hasNextPage}
        nextPageToken={triggersResult.nextPageToken}
        rows={rows}
      />
    )
  }

  const schedulesResult = await listWorkflowSchedulesCachedQuery(selectedAgent.name, {
    limit: 50,
    page_token: pageToken,
  })
  if (schedulesResult.error) {
    return <ErrorPanel message={schedulesResult.error.message} />
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(selectedAgent.name)
  const workflows = workflowsResult.error ? [] : (workflowsResult.summaries ?? [])

  return (
    <ScheduleTriggersTable
      key={selectedAgent.name}
      agentName={selectedAgent.name}
      deleteWorkflowScheduleAction={deleteWorkflowScheduleFormAction}
      getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
      hasNextPage={schedulesResult.hasNextPage}
      nextPageToken={schedulesResult.nextPageToken}
      triggerWorkflowRunAction={triggerWorkflowRunAction}
      updateWorkflowScheduleAction={updateWorkflowScheduleFormAction}
      workflowSchedules={schedulesResult.workflowSchedules}
      workflows={workflows}
    />
  )
}

async function HeaderAction({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const requestedAgentName = searchParams.agent_name
  const requestedType = searchParams.type
  const selectedType = requestedType === "webhook" ? "webhook" : "schedule"
  if (selectedType === "webhook") {
    return (
      <Button asChild>
        <Link href="/settings/api-keys">
          <Webhook data-icon="inline-start" />
          Manage webhook keys
        </Link>
      </Button>
    )
  }

  const agentsResult = await listAgentsCachedQuery()
  if (agentsResult.error) {
    return null
  }

  const selectedAgent =
    agentsResult.agents?.find((agent) => agent.name === requestedAgentName) ??
    agentsResult.agents?.[0]
  if (!selectedAgent) {
    return null
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(selectedAgent.name)
  return (
    <NewScheduleButton
      key={selectedAgent.name}
      agentName={selectedAgent.name}
      createWorkflowScheduleAction={createWorkflowScheduleFormAction}
      getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
      workflows={workflowsResult.error ? [] : (workflowsResult.summaries ?? [])}
    />
  )
}

function FiltersSkeleton() {
  return (
    <div className="bg-background border-b px-6 py-2">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-52 rounded-md sm:w-64" />
          <Skeleton className="h-8 w-full min-w-40 rounded-md sm:w-44" />
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
