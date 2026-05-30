"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Usb } from "lucide-react"
import Link from "next/link"

export function NavMCPs() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Link href="/mcps">
          <SidebarMenuButton tooltip="MCPs">
            <Usb />
            <span>MCPs</span>
          </SidebarMenuButton>
        </Link>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
