import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { resolvePageSelection, type ResolvedPageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import { getMcpGraphAction } from "@/data/lens.actions"
import {
  McpEmptyState,
  McpGraph,
  McpGraphSkeleton,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/mcp/mcp-graph"
import { LensFilters } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/lens-filters"
import { lensDateRange } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/search-params"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"
import type { WorkspaceType } from "@/lib/gateway/client"
import { CircleAlert } from "lucide-react"

export const metadata: Metadata = {
  title: "MCP Observability",
}

const mcpSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  app_client_id: searchParamStringSchema,
  session_id: searchParamStringSchema,
  from: searchParamStringSchema,
  to: searchParamStringSchema,
})

type McpSearchParams = {
  agent_name?: SearchParamStringInput
  app_client_id?: SearchParamStringInput
  session_id?: SearchParamStringInput
  from?: SearchParamStringInput
  to?: SearchParamStringInput
}

/**
 * McpPage renders MCP observability for one selected agent and date range.
 */
export default async function McpPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<McpSearchParams>
}) {
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (workspace.kind !== "ready") {
    return <ErrorPanel message="Workspace is unavailable" />
  }
  if (!workspace.workspace.capabilities.observability.read) {
    return <ErrorPanel message="You do not have Lens access in this Workspace" />
  }

  const resolved = resolveMcpSearchParams(searchParams)
  const workspaceId = workspace.workspace.id
  const contentKey = JSON.stringify(await resolved)
  const selection = resolved.then((params) =>
    resolvePageSelection(workspace, "lens/mcp", {
      agent_name: params.agentName,
      app_client_id: params.appClientID,
      session_id: params.sessionID,
    })
  )

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="MCP Observability" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <Suspense
          fallback={
            <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
              <Skeleton className="h-8 w-full sm:w-64" />
              <Skeleton className="h-8 w-full sm:w-72" />
            </div>
          }
        >
          <Filters searchParams={resolved} selection={selection} />
        </Suspense>
        <Suspense key={contentKey} fallback={<McpGraphSkeleton />}>
          <Graph
            searchParams={resolved}
            workspaceId={workspaceId}
            workspaceType={workspace.workspace.type}
            selection={selection}
          />
        </Suspense>
      </div>
    </main>
  )
}

async function Filters({
  searchParams,
  selection,
}: {
  searchParams: Promise<ResolvedMcpSearchParams>
  selection: Promise<ResolvedPageSelection>
}) {
  const [{ range }, scope] = await Promise.all([searchParams, selection])
  if (scope.error) return <ErrorPanel message={scope.error.message} />
  return (
    <>
      <RememberPageSelection selected={scope.selected} requested={scope.requested} />
      <LensFilters
        workspaceId={scope.workspaceId}
        defaultAppClientID={scope.defaultAppClientID}
        sessions={scope.sessions}
        selectedSessionId={scope.selected.session_id}
        sessionNextPageToken={scope.sessionNextPageToken}
        agents={scope.agents}
        apps={scope.apps}
        selectedAppClientID={scope.selected.app_client_id}
        selectedAgentName={scope.selected.agent_name}
        from={range.from}
        to={range.to}
      />
    </>
  )
}

async function Graph({
  searchParams,
  workspaceId,
  workspaceType,
  selection,
}: {
  searchParams: Promise<ResolvedMcpSearchParams>
  workspaceId: string
  workspaceType: WorkspaceType
  selection: Promise<ResolvedPageSelection>
}) {
  const params = await searchParams
  const range = params.range
  const scope = await selection

  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  if (!scope.subject) {
    return <EmptyState message="No agents or apps available" />
  }

  if (workspaceType === "coding" && scope.subject.kind === "agent" && !scope.selected.session_id) {
    return <EmptyState message="No conversations available" />
  }

  const result = await getMcpGraphAction(
    scope.subject,
    { from: range.from, to: range.to, session_id: scope.selected.session_id },
    workspaceId
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  if (result.data.connections.length === 0) {
    return <McpEmptyState subjectName={scope.subject.name} />
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1">
      <McpGraph
        subject={scope.subject}
        key={[
          scope.subject.kind !== "agent"
            ? `app:${scope.subject.clientID}`
            : `agent:${scope.subject.name}`,
          scope.selected.session_id,
          range.from,
          range.to,
          result.data.connections.length,
          result.data.tools.length,
          result.data.edges.length,
        ].join(":")}
        graph={result.data}
      />
    </section>
  )
}

type ResolvedMcpSearchParams = {
  agentName?: string
  appClientID?: string
  sessionID?: string
  range: ReturnType<typeof lensDateRange>
}

async function resolveMcpSearchParams(
  searchParams: Promise<McpSearchParams>
): Promise<ResolvedMcpSearchParams> {
  const params = mcpSearchParamsSchema.parse(await searchParams)

  return {
    agentName: params.agent_name,
    appClientID: params.app_client_id,
    sessionID: params.session_id,
    range: lensDateRange(params.from, params.to),
  }
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert className="px-6" variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}
