import type { Route } from "next"
import { notFound } from "next/navigation"
import { ScopeBadge } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getWorkspaceRoleEditorData } from "@/data/roles"

export default async function WorkspaceRoleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; roleId: string; workspaceSlug: string }>
}) {
  const { orgSlug, roleId, workspaceSlug } = await params
  const data = await getWorkspaceRoleEditorData(orgSlug, workspaceSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles/${roleId}`
  const tabs = [
    { href: `${root}/permissions` as Route, label: "Permissions" },
    { href: `${root}/assignments` as Route, label: "Assignments" },
  ] as const satisfies readonly RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 border-b pb-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ScopeBadge scope="Workspace" />
              <Badge variant={data.role.immutable ? "secondary" : "outline"}>
                {data.role.immutable ? "System" : "Custom"}
              </Badge>
              {data.role.immutable ? <Badge variant="outline">Read-only permissions</Badge> : null}
            </div>
            <h2 className="truncate text-xl font-semibold" title={data.role.name}>
              {data.role.name}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {data.role.users} User and {data.role.teams} Team assignments
            </p>
          </div>
        </div>
        <RouteTabs label="Workspace Role details" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
