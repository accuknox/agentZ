import { Suspense } from "react"
import type { Route } from "next"
import { AdministrationLoadingState } from "@/components/administration"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"

export default function WorkspaceInheritanceLayout(
  props: LayoutProps<"/orgs/[orgSlug]/workspaces/manage/[workspaceSlug]/inherited">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceInheritanceContent {...props} />
    </Suspense>
  )
}

async function WorkspaceInheritanceContent({
  children,
  params,
}: LayoutProps<"/orgs/[orgSlug]/workspaces/manage/[workspaceSlug]/inherited">) {
  const { orgSlug, workspaceSlug } = await params
  const root = `/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}/inherited`
  const tabs = [
    { href: `${root}/skills` as Route, label: "Skills" },
    { href: `${root}/sandboxes` as Route, label: "Sandboxes" },
    { href: `${root}/mcp-connections` as Route, label: "MCP Connections" },
    { href: `${root}/inference-providers` as Route, label: "Inference Providers" },
  ] satisfies RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6 pb-6">
      <div className="px-4 md:px-6">
        <RouteTabs label="Inherited resource types" tabs={tabs} />
      </div>
      {children}
    </div>
  )
}
