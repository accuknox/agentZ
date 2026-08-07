import { Suspense } from "react"
import * as z from "zod"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { deleteScopedMcpFormAction, submitScopedMcpFormAction } from "@/data/mcp.actions"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { McpTable } from "./mcp-table"
import { NewMcpButton } from "./new-mcp-button"

const searchSchema = z.object({ page_token: searchParamStringSchema })
type SearchParams = { page_token?: SearchParamStringInput }

export async function McpPage({
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
  const scope = { basePath, organizationId, workspaceId }
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <h2 className="text-xl font-semibold">MCP Connections</h2>
        {canCreate ? (
          <Suspense
            fallback={
              <Button disabled>
                <Plus />
                Connect
              </Button>
            }
          >
            <NewMcpButton submitMcpAction={submitScopedMcpFormAction.bind(null, scope)} />
          </Suspense>
        ) : null}
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <Connections
          basePath={basePath}
          organizationId={organizationId}
          searchParams={searchParams}
          workspaceId={workspaceId}
        />
      </Suspense>
    </main>
  )
}

async function Connections({
  basePath,
  organizationId,
  searchParams,
  workspaceId,
}: {
  basePath: string
  organizationId: string
  searchParams: Promise<SearchParams>
  workspaceId?: string
}) {
  const params = searchSchema.parse(await searchParams)
  const result = await listMcpConnectionsCachedQuery(
    { limit: 50, page_token: params.page_token },
    workspaceId
  )
  if (result.error)
    return (
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm">
        {result.error.message}
      </div>
    )
  return (
    <McpTable
      mcpConnections={result.mcpConnections}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
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
