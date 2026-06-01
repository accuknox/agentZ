"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { PlugZap } from "lucide-react"
import Link from "next/link"

export function NavMCPs() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Link href="/mcps">
          <SidebarMenuButton tooltip="MCPs">
            <PlugZap />
            <span>MCPs</span>
          </SidebarMenuButton>
        </Link>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
