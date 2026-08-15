import { notFound } from "next/navigation"
import { InheritedResourceForm } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/settings/inherited/inherited-resource-form"
import { AdministrationState } from "@/components/administration"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { getWorkspaceInheritedResources } from "@/data/workspaces"
import type { InheritedResourceType } from "@/lib/gateway/client"

export const metadata = { title: "Inherited resources" }

export default async function InheritedResourcePage({
  params,
}: {
  params: Promise<{ orgSlug: string; resourceTab: string; workspaceSlug: string }>
}) {
  const { orgSlug, resourceTab, workspaceSlug } = await params
  const resources: Record<string, { label: string; type: InheritedResourceType }> = {
    skills: { label: "Skills", type: "skill" },
    sandboxes: { label: "Sandboxes", type: "sandbox" },
    "mcp-connections": { label: "MCP Connections", type: "mcp_connection" },
    "inference-providers": { label: "Inference Providers", type: "inference_provider" },
  }
  const resource = resources[resourceTab]
  if (!resource) notFound()
  const result = await getWorkspaceInheritedResources(orgSlug, workspaceSlug, resource.type)
  if (!result) return <AdministrationState kind="forbidden" />

  let displayNames: Record<string, string> | undefined
  let iconSources: Record<string, string> = {}
  if (resource.type === "inference_provider") {
    const providers = await listInferenceProvidersCachedQuery()
    if (providers.error) throw new Error(providers.error.message)
    displayNames = {}
    for (const provider of providers.providers) {
      displayNames[provider.id] = provider.display_name
      iconSources[provider.id] = provider.catalog_provider
    }
  } else if (resource.type === "mcp_connection") {
    let pageToken: string | undefined
    do {
      const page = await listMcpConnectionsCachedQuery({ limit: 200, page_token: pageToken })
      if (page.error) throw new Error(page.error.message)
      for (const connection of page.mcpConnections) {
        iconSources[connection.name] = connection.endpoint_url
      }
      pageToken = page.nextPageToken || undefined
    } while (pageToken)
  }

  return (
    <InheritedResourceForm
      displayNames={displayNames}
      iconSources={iconSources}
      label={resource.label}
      orgSlug={orgSlug}
      resources={result.resources}
      resourceType={resource.type}
      workspaceSlug={workspaceSlug}
    />
  )
}
