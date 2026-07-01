"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Container } from "lucide-react"
import Link from "next/link"

export function NavSandboxes() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Link href="/sandboxes">
          <SidebarMenuButton tooltip="Sandboxes">
            <Container />
            <span>Sandboxes</span>
          </SidebarMenuButton>
        </Link>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
