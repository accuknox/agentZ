import type { Route } from "next"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"

export default async function InheritedResourcesLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/settings/inherited`
  const tabs: RouteTab[] = [
    { href: `${root}/skills` as Route, label: "Skills" },
    { href: `${root}/sandboxes` as Route, label: "Sandboxes" },
    { href: `${root}/mcp-connections` as Route, label: "MCP Connections" },
    { href: `${root}/inference-providers` as Route, label: "Inference Providers" },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Inherited Organisation resources</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Select individual Organisation resources for live, read-only use in this Workspace.
        </p>
      </div>
      <RouteTabs label="Inherited resource types" tabs={tabs} />
      {children}
    </div>
  )
}
