import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import { McpPage } from "@/app/(app)/mcps/mcp-page"

export const metadata = { title: "MCP connections" }

export default function WorkspaceMcpPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/mcps">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceMcp {...props} />
    </Suspense>
  )
}

async function WorkspaceMcp({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/mcps">) {
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
