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
import { GalleryVerticalEndIcon, AudioLinesIcon, TerminalIcon } from "lucide-react"
import { listAgentsAction } from "@/data/agent.actions"
import { NavLens } from "./lens"

// TODO: Replace this sample data when tenant/user APIs are available.
const data = {
  user: {
    name: "Murtaza U",
    email: "murtaza@accuknox.com",
  },
  teams: [
    {
      name: "Acuknox Inc",
      logo: <GalleryVerticalEndIcon />,
    },
  ],
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <Suspense fallback={<NavAgentsSkeleton />}>
            <NavAgents agents={listAgentsAction()} />
          </Suspense>
          <NavLens />
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
