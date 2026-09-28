import { Suspense } from "react"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Skeleton } from "@/components/ui/skeleton"
import { resolvePageSelection } from "@/data/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { WorkflowsFilters } from "./workflows-filters"

export default function WorkflowLayout({
  children,
  params,
}: LayoutProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows">) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AdministrationPageHeader title="Workflows" />
      <Suspense
        fallback={
          <div className="flex flex-wrap gap-2 border-b px-4 py-2 sm:px-6">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-8 w-72" />
            <Skeleton className="ml-auto h-8 w-52" />
          </div>
        }
      >
        <Filters params={params} />
      </Suspense>
      {children}
    </main>
  )
}

async function Filters({
  params,
}: Pick<LayoutProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows">, "params">) {
  const [route, requestHeaders] = await Promise.all([params, headers()])
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || scope.workspace.type === "coding") notFound()
  // Seed the persistent controls from the initial request. Client navigation reads the URL.
  const url = new URL(requestHeaders.get("x-agentz-pathname") ?? "/", "http://agentz.local")
  const selection = await resolvePageSelection(
    scope,
    url.pathname.endsWith("/evaluations") ? "workflows/evaluations" : "workflows/graphs",
    {
      agent_name: url.searchParams.get("agent_name") ?? undefined,
      workflow_name: url.searchParams.get("workflow_name") ?? undefined,
    }
  )
  if (selection.error)
    return <AdministrationState kind="failed" description={selection.error.message} />
  return (
    <WorkflowsFilters
      agents={selection.agents}
      workflows={selection.workflows}
      selectedAgentName={selection.selected.agent_name}
      selectedWorkflowName={selection.selected.workflow_name}
      workspaceId={scope.workspace.id}
    />
  )
}
