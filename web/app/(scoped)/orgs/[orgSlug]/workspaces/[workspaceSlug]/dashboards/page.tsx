import type { Metadata, Route } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { LayoutDashboard } from "lucide-react"
import { AdministrationPageHeader } from "@/components/administration"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { listDashboardsCachedQuery } from "@/data/dashboard.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export const metadata: Metadata = { title: "Dashboards" }

export default async function DashboardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [route, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.dashboards.read) {
    notFound()
  }
  const directory = await listDashboardsCachedQuery(scope.workspace.id, search.page_token)
  const root = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/dashboards`

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader
        title="Dashboards"
        description="Data published to this Workspace by agents and scheduled workflows."
      />
      <div className="px-4 pb-6 md:px-6">
        {directory.dashboards.length === 0 ? (
          <Empty className="border-primary min-h-72 border">
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
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {directory.dashboards.map((dashboard) => (
              <Link
                className="focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-3"
                href={`${root}/${dashboard.id}` as Route}
                key={dashboard.id}
              >
                <Card className="hover:bg-muted/30 h-full transition-colors">
                  <CardHeader>
                    <CardTitle>{dashboard.title}</CardTitle>
                    <p className="text-muted-foreground text-xs">
                      {dashboard.agent_name} · {dashboard.widget_count}{" "}
                      {dashboard.widget_count === 1 ? "widget" : "widgets"}
                    </p>
                  </CardHeader>
                  <CardContent className="text-muted-foreground line-clamp-3 text-sm">
                    {dashboard.description || "This dashboard has no description."}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
        {directory.next_page_token ? (
          <div className="mt-6 flex justify-end">
            <Button asChild variant="outline">
              <Link
                href={
                  `${root}?page_token=${encodeURIComponent(directory.next_page_token)}` as Route
                }
              >
                Next page
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  )
}
