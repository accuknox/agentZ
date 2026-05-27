"use client"

import { CalendarSync, Frame, Workflow, ChevronRightIcon } from "lucide-react"
import Link from "next/link"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

export function NavWorkflows() {
  const items = [
    {
      title: "Graph",
      url: "/workflows/graphs",
      icon: Frame,
    },
    {
      title: "Schedule",
      url: "/workflows/schedules",
      icon: CalendarSync,
    },
  ]
  return (
    <SidebarMenu>
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
                    <span>
                      <item.icon />
                      <Link href={item.url}> {item.title}</Link>
                    </span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </SidebarMenu>
  )
}
