import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { Skeleton } from "@/components/ui/skeleton"
import {
  getDashboardQuery,
  listAllDashboardsQuery,
  queryDashboardWidgetServer,
} from "@/data/dashboard.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import type { DashboardQueryRequest, DashboardWidget } from "@/lib/gateway/client"
import { dayjs } from "@/lib/format"
import { DashboardPicker, DashboardView, DashboardWidgetView } from "./dashboard"

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
  const [dashboard, dashboards] = await Promise.all([
    getDashboardQuery(scope.workspace.id, route.dashboardId),
    listAllDashboardsQuery(scope.workspace.id),
  ])
  if (!dashboard) notFound()
  const to = dayjs()
  const from = to.subtract(24, "hour")
  const initialRequest = {
    time_range: { from: from.toISOString(), to: to.toISOString() },
    filters: [],
  } satisfies DashboardQueryRequest
  const widgets = dashboard.definition.widgets.map((widget) => ({
    request: queryDashboardWidgetServer(
      scope.workspace.id,
      dashboard.id,
      widget.id,
      initialRequest
    ),
    widget,
  }))
  const root = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/dashboards`

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 pb-8">
      <AdministrationPageHeader
        title={dashboard.definition.title}
        description={dashboard.definition.description}
        actions={
          <DashboardPicker
            dashboards={dashboards}
            root={root}
            selectedId={dashboard.id}
            workspaceId={scope.workspace.id}
          />
        }
      />
      <DashboardView dashboard={dashboard} workspaceId={scope.workspace.id}>
        {widgets.map(({ request, widget }) => (
          <Suspense fallback={<WidgetSkeleton widget={widget} />} key={widget.id}>
            <WidgetStream request={request} widget={widget} />
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
  return <DashboardWidgetView initialData={result.data} widget={widget} />
}

function WidgetSkeleton({ widget }: { widget: DashboardWidget }) {
  const width =
    widget.width === "full"
      ? "col-span-12"
      : widget.width === "half"
        ? "col-span-12 lg:col-span-6"
        : "col-span-12 md:col-span-6 xl:col-span-4"
  return (
    <div className={`${width} py-3`}>
      <Skeleton className="h-5 w-36" />
      <Skeleton className="mt-5 h-52 w-full" />
    </div>
  )
}
