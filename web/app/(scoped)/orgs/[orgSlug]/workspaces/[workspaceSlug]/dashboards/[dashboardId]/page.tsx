import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { Skeleton } from "@/components/ui/skeleton"
import { getDashboardCachedQuery, queryDashboardWidgetServer } from "@/data/dashboard.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import type { DashboardQueryRequest, DashboardWidget } from "@/lib/gateway/client"
import { DashboardView, DashboardWidgetCard } from "./dashboard"

export const metadata: Metadata = { title: "Dashboard" }

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; dashboardId: string }>
}) {
  const route = await params
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.dashboards.read) {
    notFound()
  }
  const dashboard = await getDashboardCachedQuery(scope.workspace.id, route.dashboardId)
  if (!dashboard) notFound()
  const to = new Date()
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
  const initialRequest = {
    time_range: { from: from.toISOString(), to: to.toISOString() },
    filters: [],
  } satisfies DashboardQueryRequest
  const widgetRequests = new Map(
    dashboard.definition.widgets.map((widget) => [
      widget.id,
      queryDashboardWidgetServer(scope.workspace.id, dashboard.id, widget.id, initialRequest),
    ])
  )

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-5 pb-6">
      <AdministrationPageHeader
        title={dashboard.definition.title}
        description={dashboard.definition.description}
      />
      <DashboardView dashboard={dashboard} workspaceId={scope.workspace.id}>
        {dashboard.definition.widgets.map((widget) => (
          <Suspense fallback={<WidgetSkeleton widget={widget} />} key={widget.id}>
            <WidgetStream request={widgetRequests.get(widget.id)!} widget={widget} />
          </Suspense>
        ))}
      </DashboardView>
    </main>
  )
}

async function WidgetStream({
  request,
  widget,
}: {
  request: ReturnType<typeof queryDashboardWidgetServer>
  widget: DashboardWidget
}) {
  const result = await request
  if (result.error) {
    throw new Error(result.error.message)
  }
  return <DashboardWidgetCard initialData={result.data} widget={widget} />
}

function WidgetSkeleton({ widget }: { widget: DashboardWidget }) {
  const width =
    widget.width === "full"
      ? "col-span-12"
      : widget.width === "half"
        ? "col-span-12 lg:col-span-6"
        : "col-span-12 md:col-span-6 xl:col-span-4"
  return (
    <div className={`${width} rounded-xl border p-4`}>
      <Skeleton className="h-5 w-36" />
      <Skeleton className="mt-5 h-52 w-full" />
    </div>
  )
}
