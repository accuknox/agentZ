import { Suspense } from "react"
import { NavAgents, NavAgentsSkeleton } from "./agents"
import { NavUser } from "./user"
import { TeamSwitcher } from "./team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import type { ListAgentActionResponse } from "@/data/types"
import { NavLens } from "./lens"

export function AppSidebar({
  agents,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  agents: Promise<ListAgentActionResponse>
}) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <Suspense fallback={<NavAgentsSkeleton />}>
            <NavAgents agents={agents} />
          </Suspense>
          <Suspense fallback={null}>
            <NavLens />
          </Suspense>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={{ email: "murtaza@accuknox.com", name: "Murtaza U" }} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
