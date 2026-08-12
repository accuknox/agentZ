import type { Route } from "next"
import { notFound } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getWorkspaceRoleEditorData } from "@/data/roles"

export default async function WorkspaceRoleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; roleId: string; workspaceSlug: string }>
}) {
  const { orgSlug, roleId: encodedRoleId, workspaceSlug } = await params
  const roleId = decodeURIComponent(encodedRoleId)
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
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-normal" title={data.role.name}>
              {data.role.name}
            </h1>
          </div>
        </div>
        <RouteTabs label="Workspace Role details" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
