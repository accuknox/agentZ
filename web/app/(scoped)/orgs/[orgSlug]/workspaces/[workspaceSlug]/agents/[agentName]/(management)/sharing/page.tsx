import { notFound } from "next/navigation"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { AgentShareForm } from "../../agent-access-forms"

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

  const detail = await getWorkspaceAgentDetail(
    scope.scope.organization.id,
    scope.workspace.id,
    agentName,
    page_token
  )
  if (!detail) {
    notFound()
  }

  const actionScope: AgentActionScope = {
    basePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents`,
    workspaceId: scope.workspace.id,
  }

  return (
    <AgentShareForm
      actionScope={actionScope}
      agentName={agentName}
      shares={detail.shares}
      sharesNextPageToken={detail.sharesNextPageToken}
      teams={detail.teams}
      users={detail.users}
    />
  )
}
