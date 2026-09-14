import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { SkillsClient } from "@/app/(app)/skills/skills-client"

export const metadata = { title: "Skills" }

export default function WorkspaceSkillsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/skills">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceSkills {...props} />
    </Suspense>
  )
}

async function WorkspaceSkills({
  params,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/skills">) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  const result = await listAgentsCachedQuery(undefined, scope.workspace.id)
  const agents = result.error ? [] : result.agents
  if (!scope.workspace.capabilities.skills.read && agents.length === 0) {
    return <AdministrationState kind="forbidden" />
  }
  return (
    <SkillsClient
      agents={agents}
      canCreateImmutable={scope.workspace.capabilities.skills.create}
      canReadImmutable={scope.workspace.capabilities.skills.read}
      pageScope={{
        kind: "workspace",
        organizationName: scope.scope.organization.name,
        workspaceName: scope.workspace.name,
      }}
      workspaceId={scope.workspace.id}
    />
  )
}
