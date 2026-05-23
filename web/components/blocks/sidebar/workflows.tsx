"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Workflow } from "lucide-react"
import Link from "next/link"

export function NavWorkflows() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Link href="/workflows">
          <SidebarMenuButton tooltip="Workflows">
            <Workflow />
            <span>Workflows</span>
          </SidebarMenuButton>
        </Link>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
