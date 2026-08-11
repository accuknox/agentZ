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
    <div className="flex min-w-0 flex-col gap-6">
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <h1 className="text-2xl font-semibold tracking-normal">Inherited resources</h1>
      </div>
      <div className="px-4 md:px-6">
        <RouteTabs label="Inherited resource types" tabs={tabs} />
      </div>
      {children}
    </div>
  )
}
