"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Brain, ChevronRightIcon, Cpu, Layers3 } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { resourceLabels } from "@/lib/resource-labels"

export function NavInference({
  rootPath,
  showPools,
  showProviders,
}: {
  rootPath: string
  showPools: boolean
  showProviders: boolean
}) {
  const path = usePathname()
  const inferencePath = `${rootPath}/inference`
  const providersPath = `${inferencePath}/providers` as Route
  const poolsPath = `${inferencePath}/pools` as Route

  return (
    <Collapsible
      asChild
      defaultOpen={path.startsWith(`${inferencePath}/`)}
      className="group/inference"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip="Inference">
            <Cpu aria-hidden="true" />
            <span>Inference</span>
            <ChevronRightIcon
              aria-hidden="true"
              className="ml-auto transition-transform duration-200 group-data-[state=open]/inference:rotate-90"
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {showProviders ? (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild isActive={path === providersPath}>
                  <Link
                    aria-current={path === providersPath ? "page" : undefined}
                    href={providersPath}
                  >
                    <Brain aria-hidden="true" />
                    <span>{resourceLabels.inference.collection}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : null}
            {showPools ? (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild isActive={path === poolsPath}>
                  <Link aria-current={path === poolsPath ? "page" : undefined} href={poolsPath}>
                    <Layers3 aria-hidden="true" />
                    <span>Pools</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : null}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
