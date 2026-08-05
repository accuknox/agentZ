import { Suspense } from "react"
import type { Route } from "next"
import Link from "next/link"
import { Building2, Settings2 } from "lucide-react"
import { NavAgents } from "./agents"
import { NavUser } from "./user"
import { WorkspaceSwitcher } from "./workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarRail,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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
import { NavInference } from "./inference"
import type { OrganizationSummary } from "@/data/organizations"

export type SidebarScope =
  | { kind: "legacy" }
  | { kind: "account" }
  | { kind: "organization"; organization: OrganizationSummary }

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  user?: {
    email?: string | null
    image?: string | null
    name: string
  }
  activeOrganizationId?: string | null
  organizations?: OrganizationSummary[]
  scope: SidebarScope
}

export function AppSidebar({
  activeOrganizationId,
  organizations = [],
  scope,
  user,
  ...sidebarProps
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon" {...sidebarProps}>
      <SidebarHeader className="p-2">
        <WorkspaceSwitcher scope={scope} />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {scope.kind === "legacy" ? <LegacyNavigation /> : null}
        {scope.kind === "organization" ? (
          <OrganizationNavigation organization={scope.organization} />
        ) : null}
      </SidebarContent>
      {user ? (
        <SidebarFooter className="border-t p-2">
          <NavUser
            activeOrganizationId={activeOrganizationId}
            organizations={organizations}
            user={user}
          />
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  )
}

async function LegacyNavigation() {
  const [agents, sandboxes, skills] = await Promise.all([
    listAgentsCachedQuery(),
    listSandboxesCachedQuery({ limit: 50 }),
    listImmutableSkillsCachedQuery(),
  ])

  return (
    <>
      <SidebarGroup className="gap-y-1 px-2 py-2">
        <Suspense fallback={null}>
          <NavLens />
        </Suspense>
        <NavSandboxes />
        <NavSecrets />
        <NavInference />
        <NavMCPs />
        <NavSkills />
        <NavWorkflows />
      </SidebarGroup>
      <SidebarGroup className="px-2 py-2">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <NavAgents agents={agents} immutableSkills={skills.skills ?? []} sandboxes={sandboxes} />
      </SidebarGroup>
    </>
  )
}

function OrganizationNavigation({ organization }: { organization: OrganizationSummary }) {
  if (!organization.superadmin) {
    return null
  }

  const root = `/orgs/${organization.slug}`

  return (
    <SidebarGroup className="px-2 py-2">
      <SidebarGroupLabel>Organisation</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Workspaces">
            <Link href={`${root}/workspaces` as Route}>
              <Building2 aria-hidden="true" />
              <span>Workspaces</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="General">
            <Link href={`${root}/general` as Route}>
              <Settings2 aria-hidden="true" />
              <span>General</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}
