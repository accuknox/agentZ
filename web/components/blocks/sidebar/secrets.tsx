"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Lock } from "lucide-react"
import Link from "next/link"

export function NavSecrets() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Secrets">
          <Link href="/secrets">
            <Lock />
            <span>Secrets</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
