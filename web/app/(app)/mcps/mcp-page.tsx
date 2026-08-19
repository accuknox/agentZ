import { Suspense } from "react"
import * as z from "zod"
import { AdministrationPageHeader, type AdministrationPageScope } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { deleteScopedMcpFormAction, submitScopedMcpFormAction } from "@/data/mcp.actions"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { McpTable } from "./mcp-table"
import { McpSheet } from "./mcp-sheet"
import { NewMcpButton } from "./new-mcp-button"
import { resourceLabels } from "@/lib/resource-labels"

const searchSchema = z.object({
  page_token: searchParamStringSchema,
  sort_by: searchParamStringSchema.pipe(z.enum(["name", "created_at"]).default("created_at")),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("desc")),
})
type SearchParams = {
  page_token?: SearchParamStringInput
  sort_by?: SearchParamStringInput
  sort_order?: SearchParamStringInput
}

export async function McpPage({
  basePath,
  canCreate,
  organizationId,
  pageScope,
  searchParams,
  workspaceId,
}: {
  basePath: string
  canCreate: boolean
  organizationId: string
  pageScope: AdministrationPageScope
  searchParams: Promise<SearchParams>
  workspaceId?: string
}) {
  const scope = { basePath, organizationId, workspaceId }
  const content = (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader
        actions={canCreate ? <NewMcpButton /> : undefined}
        scope={pageScope}
        title={resourceLabels.mcp.collection}
      />
      <Suspense fallback={<TableSkeleton />}>
        <Connections
          basePath={basePath}
          canCreate={canCreate}
          organizationId={organizationId}
          searchParams={searchParams}
          workspaceId={workspaceId}
        />
      </Suspense>
    </main>
  )

  if (!canCreate) return content

  return (
    <McpSheet submitMcpAction={submitScopedMcpFormAction.bind(null, scope)}>{content}</McpSheet>
  )
}

async function Connections({
  basePath,
  canCreate,
  organizationId,
  searchParams,
  workspaceId,
}: {
  basePath: string
  canCreate: boolean
  organizationId: string
  searchParams: Promise<SearchParams>
  workspaceId?: string
}) {
  const params = searchSchema.parse(await searchParams)
  const result = await listMcpConnectionsCachedQuery(
    {
      limit: 50,
      page_token: params.page_token,
      sort_by: params.sort_by,
      sort_order: params.sort_order,
    },
    workspaceId
  )
  if (result.error)
    return (
      <Alert className="px-4 md:px-6" variant="destructive">
        <AlertDescription>{result.error.message}</AlertDescription>
      </Alert>
    )
  return (
    <McpTable
      canCreate={canCreate}
      mcpConnections={result.mcpConnections}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      sortBy={params.sort_by}
      sortOrder={params.sort_order}
      deleteMcpAction={deleteScopedMcpFormAction.bind(null, {
        basePath,
        organizationId,
        workspaceId,
      })}
      workspaceId={workspaceId}
    />
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  )
}
