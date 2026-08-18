"use client"

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Lock } from "lucide-react"
import Link from "next/link"
import type { WorkspacePath } from "@/data/types"

export function NavSecrets({ workspacePath }: { workspacePath: WorkspacePath }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Secrets">
        <Link href={`${workspacePath}/secrets`}>
          <Lock />
          <span>Secrets</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
