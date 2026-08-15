import { notFound } from "next/navigation"
import { UsersRound } from "lucide-react"
import { AdministrationState } from "@/components/administration"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { AgentSharesTable } from "../../agent-access-forms"

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
    basePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents`,
    workspaceId: scope.workspace.id,
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-2 px-4 text-lg font-medium md:px-6">
        <UsersRound aria-hidden className="text-muted-foreground size-4" />
        Current shares
      </h2>
      <AgentSharesTable
        actionScope={actionScope}
        agentName={agentName}
        nextPageToken={detail.sharesNextPageToken}
        shares={detail.shares}
        teams={detail.teams}
        users={detail.users.filter(
          (user) =>
            user.id !== detail.owner.owner_user_id &&
            user.id !== scope.scope.organizationSession.session.user.id
        )}
      />
    </section>
  )
}
