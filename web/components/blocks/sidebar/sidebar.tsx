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
  SidebarGroupLabel,
} from "@/components/ui/sidebar"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { NavLens } from "./lens"
import { NavSecrets } from "./secrets"
import { NavSandboxes } from "./sandboxes"
import { NavWorkflows } from "./workflows"
import { NavMCPs } from "./mcps"

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  user?: {
    email?: string | null
    image?: string | null
    name: string
  }
}

export async function AppSidebar({ user, ...sidebarProps }: AppSidebarProps) {
  const agents = listAgentsCachedQuery()
  return (
    <Sidebar collapsible="icon" {...sidebarProps}>
      <SidebarHeader>
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="gap-y-1">
          <Suspense fallback={null}>
            <NavLens />
          </Suspense>
          <NavSecrets />
          <NavSandboxes />
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
      {user ? (
        <SidebarFooter>
          <NavUser user={user} />
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  )
}
