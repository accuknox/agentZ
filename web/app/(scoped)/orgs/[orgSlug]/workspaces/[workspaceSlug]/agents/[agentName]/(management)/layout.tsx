import type { Route } from "next"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { AgentShareDialog } from "../agent-access-forms"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentName: string }>
}): Promise<Metadata> {
  const { agentName } = await params
  return {
    title: {
      default: agentName,
      template: `${agentName} - %s | AccuKnox AgentZ`,
    },
  }
}

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

  const detail = await getWorkspaceAgentDetail(scope.workspace.id, agentName)
  if (!detail) {
    notFound()
  }

  const root =
    `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents/${agentName}` as Route
  const tabs: RouteTab[] = [{ href: root, label: "Summary" }]
  if (detail.agent.capabilities.manage_ownership) {
    tabs.push({ href: `${root}/ownership` as Route, label: "Ownership" })
  }
  if (detail.agent.capabilities.share) {
    tabs.push({ href: `${root}/sharing` as Route, label: "Sharing" })
  }
  const actionScope: AgentActionScope = {
    basePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents`,
    workspaceId: scope.workspace.id,
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <h1 className="truncate text-2xl font-semibold tracking-normal" title={detail.agent.name}>
            {detail.agent.name}
          </h1>
          {detail.agent.capabilities.share ? (
            <AgentShareDialog
              actionScope={actionScope}
              agentName={agentName}
              teams={detail.teams}
              users={detail.users.filter(
                (user) =>
                  user.id !== detail.owner.owner_user_id &&
                  user.id !== scope.scope.organizationSession.session.user.id
              )}
            />
          ) : null}
        </div>
        <RouteTabs label="Agent settings" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
