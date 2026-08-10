import { notFound } from "next/navigation"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { AgentShareForm } from "../agent-access-forms"

export default async function AgentSharingPage({
  params,
}: {
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

  const actionScope: AgentActionScope = {
    basePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents`,
    workspaceId: scope.workspace.id,
  }

  return (
    <AgentShareForm
      actionScope={actionScope}
      agentName={agentName}
      shares={detail.shares}
      teams={detail.teams}
      users={detail.users}
    />
  )
}
