"use client"

import { ChevronRightIcon, Frame, Workflow, Zap } from "lucide-react"
import Link from "next/link"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import type { WorkspacePath } from "@/data/types"

export function NavWorkflows({ workspacePath }: { workspacePath: WorkspacePath }) {
  const items = [
    {
      title: "Graph",
      url: `${workspacePath}/workflows/graphs` as const,
      icon: Frame,
    },
    {
      title: "Triggers",
      url: `${workspacePath}/workflows/triggers` as const,
      icon: Zap,
    },
  ]
  return (
    <Collapsible key="Workflows" asChild className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip="Workflows">
            <Workflow />
            <span>Workflows</span>
            <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((item) => (
              <SidebarMenuSubItem key={item.title}>
                <SidebarMenuSubButton asChild>
                  <Link href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
