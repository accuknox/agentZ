import type { Route } from "next"
import { RouteTabs } from "@/components/route-tabs"

export default async function ObservabilityLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/observability`

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b px-4 py-2 md:px-6">
        <RouteTabs
          label="Observability navigation"
          tabs={[
            { href: `${root}/traces` as Route, label: "Traces" },
            { href: `${root}/runtime-telemetry` as Route, label: "Runtime telemetry" },
            { href: `${root}/mcp` as Route, label: "MCP" },
          ]}
        />
      </div>
      {children}
    </div>
  )
}
