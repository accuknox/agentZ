import type { Route } from "next"
import { notFound } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getTeamDetail } from "@/data/teams"

export default async function TeamLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const team = await getTeamDetail(orgSlug, teamId)
  if (!team) notFound()
  const root = `/orgs/${orgSlug}/teams/${teamId}`
  const tabs = [
    { href: root as Route, label: "Summary" },
    { href: `${root}/members` as Route, label: "Members" },
    { href: `${root}/roles` as Route, label: "Roles and Access" },
    { href: `${root}/shared-agents` as Route, label: "Shared Agents" },
    { href: `${root}/activity` as Route, label: "Activity" },
  ] as const satisfies readonly RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 border-b pb-1">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold" title={team.name}>
            {team.name}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {team.memberCount} Members · {team.roleCount} Roles
          </p>
        </div>
        <RouteTabs label="Team details" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
