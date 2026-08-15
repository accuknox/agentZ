"use client"

import type { Route } from "next"
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Lock } from "lucide-react"
import Link from "next/link"

export function NavSecrets({ workspacePath }: { workspacePath: Route }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Secrets">
        <Link href={`${workspacePath}/secrets` as Route}>
          <Lock />
          <span>Secrets</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
