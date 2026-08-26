import type { Metadata } from "next"
import { Suspense, type ComponentProps } from "react"
import * as z from "zod"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import {
  getDashboardCachedQuery,
  listDashboardsCachedQuery,
  queryDashboardInitial,
} from "@/data/dashboard.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { dayjs } from "@/lib/format"
import { DashboardSkeleton } from "./dashboard-skeleton"
import { DashboardView } from "./dashboard-view"

export const metadata: Metadata = { title: "Dashboards" }

const searchSchema = z.object({
  agent_name: z.string().optional(),
  dashboard_name: z.string().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

export default async function DashboardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const route = await params
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AdministrationPageHeader title="Dashboards" />
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent route={route} searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function DashboardContent({
  route,
  searchParams,
}: {
  route: { orgSlug: string; workspaceSlug: string }
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  const parsed = searchSchema.safeParse(await searchParams)
  const search = parsed.success ? parsed.data : {}
  const listed = await listDashboardsCachedQuery(scope.workspace.id)
  if (listed.error)
    return (
      <AdministrationState
        kind="failed"
        title="Unable to load dashboards"
        description={listed.error.message}
      />
    )
  if (listed.dashboards.length === 0)
    return (
      <AdministrationState
        kind="empty"
        title="No dashboards"
        description="Ask an agent to create a dashboard from its results."
      />
    )

  const selected =
    listed.dashboards.find(
      (dashboard) =>
        dashboard.agent_name === search.agent_name && dashboard.name === search.dashboard_name
    ) ?? listed.dashboards.at(0)
  if (!selected) return <AdministrationState kind="empty" title="No dashboards" />
  const loaded = await getDashboardCachedQuery(
    scope.workspace.id,
    selected.agent_name,
    selected.name
  )
  if (loaded.error)
    return (
      <AdministrationState
        kind="failed"
        title="Unable to load dashboard"
        description={loaded.error.message}
      />
    )

  const now = dayjs()
  const from = dayjs(search.from ?? now)
    .startOf("day")
    .toISOString()
  const to = dayjs(search.to ?? now)
    .endOf("day")
    .toISOString()
  const workspacePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`
  return (
    <Suspense fallback={<DashboardSkeleton dashboard={loaded.dashboard} />}>
      <DashboardData
        dashboard={loaded.dashboard}
        dashboards={listed.dashboards}
        initialFrom={from}
        initialTo={to}
        workspaceId={scope.workspace.id}
        workspacePath={workspacePath}
      />
    </Suspense>
  )
}

async function DashboardData(props: Omit<ComponentProps<typeof DashboardView>, "initialData">) {
  const initialData = await queryDashboardInitial(
    props.workspaceId,
    props.dashboard.agent_name,
    props.dashboard.name,
    props.initialFrom,
    props.initialTo
  )
  return <DashboardView {...props} initialData={initialData} />
}
