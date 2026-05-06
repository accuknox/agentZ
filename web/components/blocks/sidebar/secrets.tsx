"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Lock } from "lucide-react"
import Link from "next/link"

export function NavSecrets() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Link href="/secrets">
          <SidebarMenuButton tooltip="Secrets">
            <Lock />
            <span>Secrets</span>
          </SidebarMenuButton>
        </Link>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
