import { AdministrationState } from "@/components/administration"
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
  if (scope.kind !== "ready" || !scope.workspace.skill_capabilities.read)
    return <AdministrationState kind="forbidden" />
  return (
    <SkillsClient
      canCreate={scope.workspace.skill_capabilities.create}
      workspaceId={scope.workspace.id}
    />
  )
}
