"use client"

import { usePathname } from "next/navigation"
import { Brain, Cpu, Layers3 } from "lucide-react"
import type { WorkspacePath } from "@/data/types"
import { resourceLabels } from "@/lib/resource-labels"
import { SidebarNavigationGroup } from "./navigation-link"

export function NavInference({
  rootPath,
  showPools,
  showProviders,
}: {
  rootPath: WorkspacePath
  showPools: boolean
  showProviders: boolean
}) {
  const path = usePathname()
  const inferencePath = `${rootPath}/inference` as const
  const items = [
    {
      href: `${inferencePath}/providers`,
      label: resourceLabels.inference.collection,
      icon: Brain,
      visible: showProviders,
    },
    { href: `${inferencePath}/pools`, label: "Pools", icon: Layers3, visible: showPools },
  ] as const

  return (
    <SidebarNavigationGroup
      label="Inference"
      icon={Cpu}
      tour="inference"
      tourDescription={[
        showProviders ? "Add providers to give your agents access to AI models." : "",
        showPools ? "Pools group models together and allow automatic fallback." : "",
      ]
        .filter(Boolean)
        .join(" ")}
      defaultOpen={path.startsWith(`${inferencePath}/`)}
      items={items
        .filter((item) => item.visible)
        .map((item) => ({ ...item, active: path === item.href }))}
    />
  )
}
