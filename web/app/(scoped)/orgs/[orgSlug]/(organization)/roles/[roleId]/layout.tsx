import type { Route } from "next"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getRoleEditorData } from "@/data/roles"
import { RoleDelete } from "../role-delete"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string }>
}): Promise<Metadata> {
  const { orgSlug, roleId } = await params
  const data = await getRoleEditorData(orgSlug, decodeURIComponent(roleId))
  if (!data?.role) return { title: "Role" }
  return {
    title: {
      default: data.role.name,
      template: `${data.role.name} - %s | AgentZ`,
    },
  }
}

export default async function RoleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; roleId: string }>
}) {
  const { orgSlug, roleId: encodedRoleId } = await params
  const roleId = decodeURIComponent(encodedRoleId)
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
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-3">
              <h1
                className="truncate text-2xl font-semibold tracking-normal"
                title={data.role.name}
              >
                {data.role.name}
              </h1>
              <span className="text-muted-foreground shrink-0 text-sm">
                {data.role.immutable ? "System · Read-only" : "Custom"}
              </span>
            </div>
          </div>
        </div>
        {!data.role.immutable ? (
          <RoleDelete
            name={data.role.name}
            orgSlug={orgSlug}
            roleId={roleId}
            updatedAt={data.role.updatedAt}
          />
        ) : null}
        <RouteTabs label="Role details" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
