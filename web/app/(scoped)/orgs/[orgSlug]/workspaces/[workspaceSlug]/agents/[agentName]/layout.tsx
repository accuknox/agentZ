import type { Route } from "next"
import { notFound } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export default async function WorkspaceAgentLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentName: string }>
}) {
  const { orgSlug, workspaceSlug, agentName } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") {
    notFound()
  }

  const detail = await getWorkspaceAgentDetail(
    scope.scope.organization.id,
    scope.workspace.id,
    agentName
  )
  if (!detail) {
    notFound()
  }

  const root =
    `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents/${agentName}` as Route
  const tabs = [
    { href: root, label: "Summary" },
    { href: `${root}/ownership` as Route, label: "Ownership" },
    { href: `${root}/sharing` as Route, label: "Sharing" },
  ] as const satisfies readonly RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-normal" title={detail.agent.name}>
            {detail.agent.name}
          </h1>
        </div>
        <RouteTabs label="Agent settings" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
