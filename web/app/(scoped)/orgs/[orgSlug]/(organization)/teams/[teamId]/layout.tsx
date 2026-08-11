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
    { href: `${root}/roles` as Route, label: "Roles and access" },
    { href: `${root}/shared-agents` as Route, label: "Shared agents" },
    { href: `${root}/activity` as Route, label: "Activity" },
  ] as const satisfies readonly RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-normal" title={team.name}>
            {team.name}
          </h1>
        </div>
        <RouteTabs label="Team details" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
