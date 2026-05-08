"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Container } from "lucide-react"
import Link from "next/link"

export function NavEnvironments() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Link href="/environments">
          <SidebarMenuButton tooltip="Environments">
            <Container />
            <span>Environments</span>
          </SidebarMenuButton>
        </Link>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
