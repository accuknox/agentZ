"use client"

import { usePathname } from "next/navigation"
import { Cable, RouteIcon, Search, Server } from "lucide-react"
import type { WorkspacePath } from "@/data/types"
import { resourceLabels } from "@/lib/resource-labels"
import { SidebarNavigationGroup } from "./navigation-link"

export function NavLens({ rootPath }: { rootPath: WorkspacePath }) {
  const path = usePathname()
  const lensPath = `${rootPath}/lens` as const
  const items = [
    { href: `${lensPath}/traces`, icon: RouteIcon, label: "Traces" },
    { href: `${lensPath}/runtime-telemetry`, icon: Server, label: "Runtime telemetry" },
    { href: `${lensPath}/mcp`, icon: Cable, label: resourceLabels.mcpActivity.collection },
  ] as const

  return (
    <SidebarNavigationGroup
      label="Lens"
      icon={Search}
      tour="lens"
      defaultOpen={path.startsWith(lensPath)}
      items={items.map((item) => ({
        ...item,
        active: path === item.href || path.startsWith(`${item.href}/`),
      }))}
    />
  )
}
