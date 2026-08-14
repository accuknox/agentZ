import { Suspense } from "react"
import { AdministrationState } from "@/components/administration"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { SkillsClient } from "@/app/(app)/skills/skills-client"

export const unstable_instant = false

export default async function WorkspaceSkillsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  const result = await listAgentsCachedQuery(undefined, scope.workspace.id)
  const agents = result.error ? [] : result.agents
  if (!scope.workspace.skill_capabilities.read && agents.length === 0) {
    return <AdministrationState kind="forbidden" />
  }
  return (
    <Suspense fallback={null}>
      <SkillsClient
        agents={agents}
        canCreateImmutable={scope.workspace.skill_capabilities.create}
        canReadImmutable={scope.workspace.skill_capabilities.read}
        workspaceId={scope.workspace.id}
      />
    </Suspense>
  )
}
