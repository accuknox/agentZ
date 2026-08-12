"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Cable, ChevronRightIcon, RouteIcon, Search, Server } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

export function NavLens({ rootPath }: { rootPath: string }) {
  const path = usePathname()
  const lensPath = `${rootPath}/lens`
  const items = [
    { href: `${lensPath}/traces` as Route, icon: RouteIcon, label: "Traces" },
    {
      href: `${lensPath}/runtime-telemetry` as Route,
      icon: Server,
      label: "Runtime Telemetry",
    },
    { href: `${lensPath}/mcp` as Route, icon: Cable, label: "MCP" },
  ]

  return (
    <Collapsible asChild defaultOpen={path.startsWith(lensPath)} className="group/lens">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip="Lens">
            <Search aria-hidden="true" />
            <span>Lens</span>
            <ChevronRightIcon
              aria-hidden="true"
              className="ml-auto transition-transform duration-200 group-data-[state=open]/lens:rotate-90"
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((item) => {
              const active = path === item.href || path.startsWith(`${item.href}/`)
              const Icon = item.icon

              return (
                <SidebarMenuSubItem key={item.href}>
                  <SidebarMenuSubButton asChild isActive={active}>
                    <Link aria-current={active ? "page" : undefined} href={item.href}>
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
