import type { Route } from "next"
import { notFound } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getRoleEditorData } from "@/data/roles"

export default async function RoleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; roleId: string }>
}) {
  const { orgSlug, roleId } = await params
  const data = await getRoleEditorData(orgSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  const root = `/orgs/${orgSlug}/roles/${roleId}`
  const tabs = [
    { href: `${root}/permissions` as Route, label: "Permissions" },
    { href: `${root}/assignments` as Route, label: "Assignments" },
  ] as const satisfies readonly RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 border-b pb-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-3">
              <h2 className="truncate text-xl font-semibold" title={data.role.name}>
                {data.role.name}
              </h2>
              <span className="text-muted-foreground shrink-0 text-sm">
                {data.role.immutable ? "System · Read-only" : "Custom"}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {data.role.users} User and {data.role.teams} Team assignments
            </p>
          </div>
        </div>
        <RouteTabs label="Role details" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
