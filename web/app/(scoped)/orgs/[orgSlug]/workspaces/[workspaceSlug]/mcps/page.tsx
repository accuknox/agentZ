import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import { McpPage } from "@/app/(app)/mcps/mcp-page"

export const unstable_instant = false

export const metadata = { title: "MCP connections" }

export default async function WorkspaceMcpPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.mcp_connections.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/mcps`
  return (
    <McpPage
      basePath={basePath}
      canCreate={scope.workspace.capabilities.mcp_connections.create}
      organizationId={scope.scope.organization.id}
      pageScope={{
        kind: "workspace",
        organizationName: scope.scope.organization.name,
        workspaceName: scope.workspace.name,
      }}
      searchParams={searchParams}
      workspaceId={scope.workspace.id}
    />
  )
}
