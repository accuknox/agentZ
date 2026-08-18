import { AdministrationPageHeader } from "@/components/administration"
import { Skeleton } from "@/components/ui/skeleton"
import { McpGraphSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/mcp/mcp-graph"

/**
 * Loading renders a stable skeleton while the MCP graph route streams.
 */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="MCP Observability" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
          <Skeleton className="h-8 w-full sm:w-64" />
          <Skeleton className="h-8 w-full sm:w-72" />
        </div>
        <McpGraphSkeleton />
      </div>
    </main>
  )
}
