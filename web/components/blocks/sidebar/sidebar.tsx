import { Suspense } from "react"
import { connection } from "next/server"
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
  SidebarGroupLabel,
} from "@/components/ui/sidebar"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { NavLens } from "./lens"
import { NavSecrets } from "./secrets"
import { NavEnvironments } from "./environments"
import { NavWorkflows } from "./workflows"
import { NavMCPs } from "./mcps"

export async function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  await connection()
  const agents = listAgentsCachedQuery()
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="gap-y-1">
          <Suspense fallback={null}>
            <NavLens />
          </Suspense>
          <NavSecrets />
          <NavEnvironments />
          <NavWorkflows />
          <NavMCPs />
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <Suspense fallback={<NavAgentsSkeleton />}>
            <NavAgents agents={agents} />
          </Suspense>
        </SidebarGroup>
      </SidebarContent>
      {/*<SidebarFooter>
        <NavUser user={{ email: "murtaza@accuknox.com", name: "Murtaza U" }} />
      </SidebarFooter>*/}
      <SidebarRail />
    </Sidebar>
  )
}
