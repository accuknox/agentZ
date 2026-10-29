import { RememberRoute, missingRoute } from "@/data/route-memory"
import { Suspense } from "react"
import { InheritedResourceForm } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/settings/inherited/inherited-resource-form"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { listGuardrailConnectionsQuery, listGuardrailPoliciesQuery } from "@/data/guardrail.queries"
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

async function InheritedResourceContent(
  props: PageProps<"/orgs/[orgSlug]/workspaces/manage/[workspaceSlug]/inherited/[resourceTab]">
) {
  const {
    params,
    searchParams,
  } = props

  const [{ orgSlug, resourceTab, workspaceSlug }, search] = await Promise.all([
    params,
    searchParams,
  ])
  const sorting = searchSchema.parse(search)
  const resources: Record<string, { label: string; type: InheritedResourceType }> = {
    "guardrail-providers": { label: "Guardrail providers", type: "guardrail_connection" },
    "guardrail-policies": { label: "Optional guardrail policies", type: "guardrail_policy" },
    skills: { label: "Skills", type: "skill" },
    sandboxes: { label: "Sandboxes", type: "sandbox" },
    "mcp-connections": { label: "MCP Connections", type: "mcp_connection" },
    "inference-providers": { label: "Inference Providers", type: "inference_provider" },
  }
  const resource = resources[resourceTab]
  if (!resource) return missingRoute()
  const result = await getWorkspaceInheritedResources(
    orgSlug,
    workspaceSlug,
    resource.type,
    sorting.sort_by,
    sorting.sort_order
  )
  if (!result) return <AdministrationState kind="forbidden" />

  let displayNames: Record<string, string> | undefined
  const iconSources: Record<string, string> = {}
  if (resource.type === "guardrail_policy" || resource.type === "guardrail_connection") {
    const result =
      resource.type === "guardrail_policy"
        ? await listGuardrailPoliciesQuery()
        : await listGuardrailConnectionsQuery()
    if (result.error) throw new Error(result.error.message)
    displayNames = Object.fromEntries(
      result.data.items.map((item) => [item.name, item.displayName])
    )
  }
  if (resource.type === "inference_provider") {
    const providers = await listInferenceProvidersCachedQuery()
    if (providers.error) throw new Error(providers.error.message)
    displayNames = {}
    for (const provider of providers.providers) {
      displayNames[provider.id] = provider.display_name
      iconSources[provider.id] = provider.catalog_provider
    }
  }
  if (resource.type === "mcp_connection") {
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
    <>
      <RememberRoute />
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
    </>
  )
}
