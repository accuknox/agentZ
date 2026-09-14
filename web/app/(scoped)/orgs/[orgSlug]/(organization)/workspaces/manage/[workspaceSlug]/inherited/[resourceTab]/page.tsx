import { Suspense } from "react"
import { notFound } from "next/navigation"
import { InheritedResourceForm } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/settings/inherited/inherited-resource-form"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { getWorkspaceInheritedResources } from "@/data/workspaces"
import type { InheritedResourceType } from "@/lib/gateway/client"
import * as z from "zod"
import { searchParamStringSchema } from "@/lib/search-params"

export const metadata = { title: "Inherited resources" }

const searchSchema = z.object({
  sort_by: searchParamStringSchema.pipe(z.enum(["name", "status"]).default("name")),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("asc")),
})

export default function InheritedResourcePage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/manage/[workspaceSlug]/inherited/[resourceTab]">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <InheritedResourceContent {...props} />
    </Suspense>
  )
}

async function InheritedResourceContent({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/manage/[workspaceSlug]/inherited/[resourceTab]">) {
  const [{ orgSlug, resourceTab, workspaceSlug }, search] = await Promise.all([
    params,
    searchParams,
  ])
  const sorting = searchSchema.parse(search)
  const resources: Record<string, { label: string; type: InheritedResourceType }> = {
    skills: { label: "Skills", type: "skill" },
    sandboxes: { label: "Sandboxes", type: "sandbox" },
    "mcp-connections": { label: "MCP Connections", type: "mcp_connection" },
    "inference-providers": { label: "Inference Providers", type: "inference_provider" },
  }
  const resource = resources[resourceTab]
  if (!resource) notFound()
  const result = await getWorkspaceInheritedResources(
    orgSlug,
    workspaceSlug,
    resource.type,
    sorting.sort_by,
    sorting.sort_order
  )
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
      sortBy={sorting.sort_by}
      sortOrder={sorting.sort_order}
      workspaceSlug={workspaceSlug}
    />
  )
}
