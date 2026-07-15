import { Suspense } from "react"
import { NavAgents } from "./agents"
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
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"
import { NavLens } from "./lens"
import { NavSecrets } from "./secrets"
import { NavSandboxes } from "./sandboxes"
import { NavSkills } from "./skills"
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
  const [agents, sandboxes, skills] = await Promise.all([
    listAgentsCachedQuery(),
    listSandboxesCachedQuery({ limit: 50 }),
    listImmutableSkillsCachedQuery(),
  ])

  return (
    <Sidebar collapsible="icon" {...sidebarProps}>
      <SidebarHeader className="p-2">
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <SidebarGroup className="gap-y-1 px-2 py-2">
          <Suspense fallback={null}>
            <NavLens />
          </Suspense>
          <NavSandboxes />
          <NavSecrets />
          <NavMCPs />
          <NavSkills />
          <NavWorkflows />
        </SidebarGroup>
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <NavAgents agents={agents} immutableSkills={skills.skills ?? []} sandboxes={sandboxes} />
        </SidebarGroup>
      </SidebarContent>
      {user ? (
        <SidebarFooter className="border-t p-2">
          <NavUser user={user} />
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  )
}
