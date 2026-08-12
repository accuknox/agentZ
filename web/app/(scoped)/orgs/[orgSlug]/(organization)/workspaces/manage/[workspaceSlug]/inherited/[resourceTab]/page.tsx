import { notFound } from "next/navigation"
import { InheritedResourceForm } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/settings/inherited/inherited-resource-form"
import { AdministrationState } from "@/components/administration"
import { getWorkspaceInheritedResources } from "@/data/workspaces"
import type { InheritedResourceType } from "@/lib/gateway/client"

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

  return (
    <InheritedResourceForm
      label={resource.label}
      orgSlug={orgSlug}
      resources={result.resources}
      resourceType={resource.type}
      workspaceSlug={workspaceSlug}
    />
  )
}
