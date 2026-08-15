import type { Route } from "next"
import { redirect } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />

  const root = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}` as const
  if (scope.workspace.capabilities.agents.author) redirect(`${root}/agents` as Route)
  const agents = await listAgentsCachedQuery(undefined, scope.workspace.id)
  if (!agents.error && agents.agents.length > 0) redirect(`${root}/agents` as Route)
  if (scope.scope.organization.superadmin || scope.workspace.capabilities.administer) {
    redirect(`${root}/roles` as Route)
  }
  if (scope.workspace.capabilities.observability.read) redirect(`${root}/lens/traces` as Route)
  if (scope.workspace.capabilities.skills.read) redirect(`${root}/skills` as Route)
  if (scope.workspace.capabilities.mcp_connections.read) redirect(`${root}/mcps` as Route)
  if (scope.workspace.capabilities.sandboxes.read) redirect(`${root}/sandboxes` as Route)
  if (scope.workspace.capabilities.inference_providers.read) {
    redirect(`${root}/inference/providers` as Route)
  }
  if (scope.workspace.capabilities.inference_pools.read) {
    redirect(`${root}/inference/pools` as Route)
  }

  return <AdministrationState kind="forbidden" />
}
