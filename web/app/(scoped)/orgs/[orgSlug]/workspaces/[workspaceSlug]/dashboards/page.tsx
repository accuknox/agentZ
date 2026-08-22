import type { Metadata, Route } from "next"
import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { LayoutDashboard } from "lucide-react"
import { AdministrationPageHeader } from "@/components/administration"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { listAllDashboardsQuery } from "@/data/dashboard.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export const metadata: Metadata = { title: "Dashboards" }

export default async function DashboardsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const route = await params
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.dashboards.read) {
    notFound()
  }

  const dashboards = await listAllDashboardsQuery(scope.workspace.id)
  const [firstDashboard] = dashboards
  if (firstDashboard) {
    const cookieName = `agentz-last-dashboard-${scope.workspace.id}`
    const lastDashboardId = (await cookies()).get(cookieName)?.value
    const selected = dashboards.find((dashboard) => dashboard.id === lastDashboardId)
    const dashboardId = selected?.id ?? firstDashboard.id
    const root = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/dashboards`
    redirect(`${root}/${dashboardId}` as Route)
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader title="Dashboards" />
      <div className="px-4 pb-6 md:px-6">
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No dashboards yet</EmptyTitle>
            <EmptyDescription>
              Run the agent task once, check the fields it produces, then ask the agent to build a
              dashboard.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </main>
  )
}
