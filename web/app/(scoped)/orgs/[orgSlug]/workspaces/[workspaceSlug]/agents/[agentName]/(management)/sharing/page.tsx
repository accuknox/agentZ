import { notFound } from "next/navigation"
import { UsersRound } from "lucide-react"
import { AdministrationState } from "@/components/administration"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { AgentShareDialog, AgentSharesTable } from "../../agent-access-forms"

export const metadata = { title: "Sharing" }

export default async function AgentSharingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentName: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [{ orgSlug, workspaceSlug, agentName }, { page_token }] = await Promise.all([
    params,
    searchParams,
  ])
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") {
    notFound()
  }

  const detail = await getWorkspaceAgentDetail(scope.workspace.id, agentName, page_token)
  if (!detail) {
    notFound()
  }
  if (!detail.agent.capabilities.share) {
    return <AdministrationState kind="forbidden" />
  }

  const actionScope: AgentActionScope = {
    workspaceId: scope.workspace.id,
    workspacePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`,
  }
  const shareTargets = {
    teams: detail.teams,
    users: detail.users.filter(
      (user) =>
        user.id !== detail.owner.owner_user_id &&
        user.id !== scope.scope.organizationSession.session.user.id
    ),
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-4 px-4 md:px-6">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <UsersRound aria-hidden className="text-muted-foreground size-4" />
          Current shares
        </h2>
        <AgentShareDialog
          actionScope={actionScope}
          agentName={agentName}
          teams={shareTargets.teams}
          users={shareTargets.users}
        />
      </div>
      {detail.shares.length === 0 ? (
        <AdministrationState
          actions={
            <AgentShareDialog
              actionScope={actionScope}
              agentName={agentName}
              teams={shareTargets.teams}
              users={shareTargets.users}
            />
          }
          description="Share this Agent with a User or Team, then choose what they may do with it."
          kind="empty"
          title="No shares yet"
        />
      ) : (
        <AgentSharesTable
          actionScope={actionScope}
          agentName={agentName}
          nextPageToken={detail.sharesNextPageToken}
          shares={detail.shares}
          teams={shareTargets.teams}
          users={shareTargets.users}
        />
      )}
    </section>
  )
}
