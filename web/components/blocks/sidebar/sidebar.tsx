import { Suspense } from "react"
import type { Route } from "next"
import Link from "next/link"
import {
  Box,
  Brain,
  Building2,
  Cable,
  Layers3,
  LayoutDashboard,
  ScrollText,
  Settings2,
} from "lucide-react"
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
import { NavWorkflows } from "./workflows"
import type { OrganizationSummary } from "@/data/organizations"
import type { ResourceCapabilities, Workspace } from "@/lib/gateway/client"

type WorkspaceNavigationScope = {
  canCreateWorkspace: boolean
  canEnterOrganization: boolean
  organization: OrganizationSummary
  mcpConnectionCapabilities: ResourceCapabilities
  inferencePoolCapabilities: ResourceCapabilities
  inferenceProviderCapabilities: ResourceCapabilities
  sandboxCapabilities: ResourceCapabilities
  skillCapabilities: ResourceCapabilities
  workspaces: Workspace[]
}

export type SidebarScope =
  | { kind: "legacy" }
  | { kind: "account" }
  | ({ kind: "organization" } & WorkspaceNavigationScope)
  | ({ kind: "workspace"; workspace: Workspace } & WorkspaceNavigationScope)

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
          <OrganizationNavigation
            canEnterOrganization={scope.canEnterOrganization}
            mcpConnectionCapabilities={scope.mcpConnectionCapabilities}
            inferenceProviderCapabilities={scope.inferenceProviderCapabilities}
            organization={scope.organization}
            skillCapabilities={scope.skillCapabilities}
            sandboxCapabilities={scope.sandboxCapabilities}
          />
        ) : null}
        {scope.kind === "workspace" && scope.workspace.state === "ready" ? (
          <WorkspaceNavigation
            mcpConnectionCapabilities={scope.mcpConnectionCapabilities}
            inferencePoolCapabilities={scope.inferencePoolCapabilities}
            inferenceProviderCapabilities={scope.inferenceProviderCapabilities}
            organization={scope.organization}
            skillCapabilities={scope.skillCapabilities}
            sandboxCapabilities={scope.sandboxCapabilities}
            workspace={scope.workspace}
          />
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

function WorkspaceNavigation({
  mcpConnectionCapabilities,
  inferencePoolCapabilities,
  inferenceProviderCapabilities,
  organization,
  skillCapabilities,
  sandboxCapabilities,
  workspace,
}: {
  mcpConnectionCapabilities: ResourceCapabilities
  inferencePoolCapabilities: ResourceCapabilities
  inferenceProviderCapabilities: ResourceCapabilities
  organization: OrganizationSummary
  skillCapabilities: ResourceCapabilities
  sandboxCapabilities: ResourceCapabilities
  workspace: Workspace
}) {
  return (
    <SidebarGroup className="px-2 py-2">
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Overview">
            <Link href={`/orgs/${organization.slug}/workspaces/${workspace.slug}` as Route}>
              <LayoutDashboard aria-hidden="true" />
              <span>Overview</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {skillCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Skills">
              <Link
                href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/skills` as Route}
              >
                <ScrollText aria-hidden="true" />
                <span>Skills</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {mcpConnectionCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="MCP">
              <Link href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/mcps` as Route}>
                <Cable aria-hidden="true" />
                <span>MCP</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {sandboxCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Sandboxes">
              <Link
                href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/sandboxes` as Route}
              >
                <Box aria-hidden="true" />
                <span>Sandboxes</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {inferenceProviderCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Inference providers">
              <Link
                href={
                  `/orgs/${organization.slug}/workspaces/${workspace.slug}/inference/providers` as Route
                }
              >
                <Brain aria-hidden="true" />
                <span>Providers</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {inferencePoolCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Inference pools">
              <Link
                href={
                  `/orgs/${organization.slug}/workspaces/${workspace.slug}/inference/pools` as Route
                }
              >
                <Layers3 aria-hidden="true" />
                <span>Pools</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
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
        <NavSecrets />
        <NavWorkflows />
      </SidebarGroup>
      <SidebarGroup className="px-2 py-2">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <NavAgents agents={agents} immutableSkills={skills.skills ?? []} sandboxes={sandboxes} />
      </SidebarGroup>
    </>
  )
}

function OrganizationNavigation({
  canEnterOrganization,
  mcpConnectionCapabilities,
  inferenceProviderCapabilities,
  organization,
  skillCapabilities,
  sandboxCapabilities,
}: {
  canEnterOrganization: boolean
  mcpConnectionCapabilities: ResourceCapabilities
  inferenceProviderCapabilities: ResourceCapabilities
  organization: OrganizationSummary
  skillCapabilities: ResourceCapabilities
  sandboxCapabilities: ResourceCapabilities
}) {
  const root = `/orgs/${organization.slug}`

  return (
    <SidebarGroup className="px-2 py-2">
      <SidebarGroupLabel>Organisation</SidebarGroupLabel>
      <SidebarMenu>
        {canEnterOrganization ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Workspaces">
              <Link href={`${root}/workspaces` as Route}>
                <Building2 aria-hidden="true" />
                <span>Workspaces</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {skillCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Skills">
              <Link href={`${root}/skills` as Route}>
                <ScrollText aria-hidden="true" />
                <span>Skills</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {mcpConnectionCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="MCP">
              <Link href={`${root}/mcps` as Route}>
                <Cable aria-hidden="true" />
                <span>MCP</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {sandboxCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Sandboxes">
              <Link href={`${root}/sandboxes` as Route}>
                <Box aria-hidden="true" />
                <span>Sandboxes</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {inferenceProviderCapabilities.read ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Inference providers">
              <Link href={`${root}/inference/providers` as Route}>
                <Brain aria-hidden="true" />
                <span>Providers</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {organization.superadmin ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Audit">
              <Link href={`${root}/audit` as Route}>
                <ScrollText aria-hidden="true" />
                <span>Audit</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {organization.superadmin ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="General">
              <Link href={`${root}/general` as Route}>
                <Settings2 aria-hidden="true" />
                <span>General</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  )
}
