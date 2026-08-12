import type { Route } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ExternalLink } from "lucide-react"
import { AdministrationState, StatusBadge } from "@/components/administration"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { Button } from "@/components/ui/button"
import { getWorkspaceScope } from "@/data/workspaces"

export default async function ManageWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.scope.kind !== "ready" || !scope.scope.organization.superadmin) {
    return <AdministrationState kind="forbidden" />
  }
  if (scope.kind !== "ready") notFound()

  const root = `/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}`
  const tabs = [
    { href: root as Route, label: "General" },
    { href: `${root}/inherited/skills` as Route, label: "Inherited Resources" },
    { href: `${root}/delete` as Route, label: "Delete" },
  ] satisfies RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold" title={scope.workspace.name}>
                {scope.workspace.name}
              </h1>
              <StatusBadge status={scope.workspace.state} />
            </div>
            <p className="text-muted-foreground mt-1 text-sm">Workspace administration</p>
          </div>
          {scope.workspace.state === "ready" ? (
            <Button asChild variant="outline">
              <Link href={`/orgs/${orgSlug}/workspaces/${workspaceSlug}/agents` as Route}>
                Open Workspace
                <ExternalLink data-icon="inline-end" />
              </Link>
            </Button>
          ) : null}
        </div>
        <RouteTabs label="Workspace administration" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
