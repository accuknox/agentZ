"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRightIcon, Cpu, Layers3, Server } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

export function NavInference() {
  const path = usePathname()

  return (
    <SidebarMenu>
      <Collapsible asChild defaultOpen={path.startsWith("/inference/")} className="group/inference">
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip="Inference">
              <Cpu />
              <span>Inference</span>
              <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/inference:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild isActive={path === "/inference/providers"}>
                  <Link href="/inference/providers">
                    <Server />
                    Providers
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild isActive={path === "/inference/pools"}>
                  <Link href="/inference/pools">
                    <Layers3 />
                    Pools
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </SidebarMenu>
  )
}
