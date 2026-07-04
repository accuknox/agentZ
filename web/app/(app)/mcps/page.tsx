import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { deleteMcpFormAction, submitMcpFormAction } from "@/data/mcp.actions"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { McpTable } from "./mcp-table"
import { NewMcpButton } from "./new-mcp-button"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "MCP Connections",
}

const mcpConnectionsSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
})

type SearchParams = {
  page_token?: SearchParamStringInput
}

export default async function MCPsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">MCP</h1>
        </div>
        <Suspense
          fallback={
            <Button disabled>
              <Plus />
              Connect
            </Button>
          }
        >
          <NewMcpButton submitMcpAction={submitMcpFormAction} />
        </Suspense>
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <McpConnections searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function McpConnections({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = mcpConnectionsSearchParamsSchema.parse(await searchParams)
  const result = await listMcpConnectionsCachedQuery({
    limit: 50,
    page_token: params.page_token,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <McpTable
      mcpConnections={result.mcpConnections}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteMcpAction={deleteMcpFormAction}
    />
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm">
      {message}
    </div>
  )
}
