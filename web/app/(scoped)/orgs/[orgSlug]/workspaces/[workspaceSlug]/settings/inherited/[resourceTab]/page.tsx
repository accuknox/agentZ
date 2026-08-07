import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { getWorkspaceInheritedResources } from "@/data/workspaces"
import type { InheritedResourceType } from "@/lib/gateway/client"
import { InheritedResourceForm } from "../inherited-resource-form"

export default async function InheritedResourcePage({
  params,
}: {
  params: Promise<{ orgSlug: string; resourceTab: string; workspaceSlug: string }>
}) {
  const { orgSlug, resourceTab, workspaceSlug } = await params
  let resource: { label: string; type: InheritedResourceType }
  switch (resourceTab) {
    case "skills":
      resource = { label: "Skills", type: "skill" }
      break
    case "sandboxes":
      resource = { label: "Sandboxes", type: "sandbox" }
      break
    case "mcp-connections":
      resource = { label: "MCP Connections", type: "mcp_connection" }
      break
    case "inference-providers":
      resource = { label: "Inference Providers", type: "inference_provider" }
      break
    default:
      notFound()
  }
  const result = await getWorkspaceInheritedResources(orgSlug, workspaceSlug, resource.type)
  if (!result) {
    return <AdministrationState kind="forbidden" />
  }
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
