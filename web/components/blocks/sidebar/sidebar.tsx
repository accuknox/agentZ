import type { Route } from "next"
import Link from "next/link"
import {
  Activity,
  ArrowLeft,
  Box,
  Bot,
  Building2,
  Cable,
  CircleUserRound,
  CloudCog,
  KeyRound,
  Monitor,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  User2,
  UserRoundCheck,
  UsersRound,
} from "lucide-react"
import { NavAgents } from "./agents"
import { NavInference } from "./inference"
import { NavLens } from "./lens"
import { SidebarNavigationLink } from "./navigation-link"
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
  | { kind: "account" }
  | { kind: "settings"; hasAppDestination: boolean }
  | { kind: "no-access"; organization: OrganizationSummary }
  | ({ kind: "organization" } & WorkspaceNavigationScope)
  | ({
      kind: "workspace"
      workspace: Workspace
      lensCapabilities: ResourceCapabilities
    } & WorkspaceNavigationScope)

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
        {scope.kind === "settings" && scope.hasAppDestination ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip="Back to app">
                <Link href="/">
                  <ArrowLeft aria-hidden="true" />
                  <span>Back to app</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : (
          <WorkspaceSwitcher scope={scope} />
        )}
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {scope.kind === "settings" ? <SettingsNavigation /> : null}
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
            lensCapabilities={scope.lensCapabilities}
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

function SettingsNavigation() {
  return (
    <SidebarGroup className="px-2 py-2">
      <SidebarGroupLabel>Personal</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarNavigationLink href="/settings/account" label="Account">
            <User2 aria-hidden="true" />
          </SidebarNavigationLink>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarNavigationLink href="/settings/api-keys" label="API Keys">
            <KeyRound aria-hidden="true" />
          </SidebarNavigationLink>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarNavigationLink href="/settings/sessions" label="Sessions">
            <Monitor aria-hidden="true" />
          </SidebarNavigationLink>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarNavigationLink href="/settings/preferences" label="Preferences">
            <SlidersHorizontal aria-hidden="true" />
          </SidebarNavigationLink>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}

async function WorkspaceNavigation({
  mcpConnectionCapabilities,
  inferencePoolCapabilities,
  inferenceProviderCapabilities,
  organization,
  lensCapabilities,
  skillCapabilities,
  sandboxCapabilities,
  workspace,
}: {
  mcpConnectionCapabilities: ResourceCapabilities
  inferencePoolCapabilities: ResourceCapabilities
  inferenceProviderCapabilities: ResourceCapabilities
  organization: OrganizationSummary
  lensCapabilities: ResourceCapabilities
  skillCapabilities: ResourceCapabilities
  sandboxCapabilities: ResourceCapabilities
  workspace: Workspace
}) {
  const workspacePath = `/orgs/${organization.slug}/workspaces/${workspace.slug}` as Route
  const agents = await listAgentsCachedQuery(undefined, workspace.id)
  const hasAgents = agents.error === undefined && agents.agents.length > 0
  const showAgents = workspace.can_author_agents || (workspace.can_use_shared_agents && hasAgents)
  const create = workspace.can_author_agents
    ? await Promise.all([
        listSandboxesCachedQuery({ limit: 50 }, workspace.id),
        listImmutableSkillsCachedQuery(workspace.id),
      ]).then(([sandboxes, skills]) => ({
        immutableSkills: skills.error ? [] : skills.skills,
        sandboxes,
      }))
    : undefined
  const hasResources =
    lensCapabilities.read ||
    skillCapabilities.read ||
    hasAgents ||
    mcpConnectionCapabilities.read ||
    sandboxCapabilities.read ||
    inferenceProviderCapabilities.read ||
    inferencePoolCapabilities.read
  const hasWorkspace = showAgents || organization.superadmin || workspace.can_administer

  return (
    <>
      {hasWorkspace ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            {showAgents ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${workspacePath}/agents` as Route} label="Agents">
                  <Bot aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {organization.superadmin || workspace.can_administer ? (
              <>
                <SidebarMenuItem>
                  <SidebarNavigationLink href={`${workspacePath}/roles` as Route} label="Roles">
                    <ShieldCheck aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarNavigationLink
                    href={`${workspacePath}/event-trail` as Route}
                    label="Event Trail"
                  >
                    <Activity aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
              </>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {hasResources ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarMenu>
            {lensCapabilities.read ? <NavLens rootPath={workspacePath} /> : null}
            {skillCapabilities.read || hasAgents ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${workspacePath}/skills` as Route} label="Skills">
                  <ScrollText aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {mcpConnectionCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${workspacePath}/mcps` as Route} label="MCP">
                  <Cable aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {sandboxCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`${workspacePath}/sandboxes` as Route}
                  label="Sandboxes"
                >
                  <Box aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {inferenceProviderCapabilities.read || inferencePoolCapabilities.read ? (
              <NavInference
                rootPath={workspacePath}
                showPools={inferencePoolCapabilities.read}
                showProviders={inferenceProviderCapabilities.read}
              />
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {showAgents ? (
        <>
          <SidebarGroup className="gap-y-1 px-2 py-2">
            <NavSecrets workspacePath={workspacePath} />
            <NavWorkflows workspacePath={workspacePath} />
          </SidebarGroup>
          <SidebarGroup className="px-2 py-2">
            <SidebarGroupLabel>Agents</SidebarGroupLabel>
            <NavAgents
              agents={agents}
              create={create}
              workspaceId={workspace.id}
              workspacePath={workspacePath}
            />
          </SidebarGroup>
        </>
      ) : null}
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
  const hasResources =
    skillCapabilities.read ||
    mcpConnectionCapabilities.read ||
    sandboxCapabilities.read ||
    inferenceProviderCapabilities.read

  return (
    <>
      {canEnterOrganization || organization.superadmin ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Organisation</SidebarGroupLabel>
          <SidebarMenu>
            {canEnterOrganization ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${root}/workspaces` as Route} label="Workspaces">
                  <Building2 aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {organization.superadmin ? (
              <>
                <SidebarMenuItem>
                  <SidebarNavigationLink href={`${root}/users` as Route} label="Users">
                    <CircleUserRound aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarNavigationLink href={`${root}/teams` as Route} label="Teams">
                    <UsersRound aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarNavigationLink href={`${root}/roles` as Route} label="Roles">
                    <ShieldCheck aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
              </>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {hasResources ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarMenu>
            {skillCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${root}/skills` as Route} label="Skills">
                  <ScrollText aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {mcpConnectionCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${root}/mcps` as Route} label="MCP">
                  <Cable aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {sandboxCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink href={`${root}/sandboxes` as Route} label="Sandboxes">
                  <Box aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {inferenceProviderCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`${root}/inference/providers` as Route}
                  label="Inference Providers"
                >
                  <CloudCog aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {organization.superadmin ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Administration</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarNavigationLink
                href={`${root}/social-admission` as Route}
                label="Social Admission"
              >
                <UserRoundCheck aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarNavigationLink href={`${root}/event-trail` as Route} label="Event Trail">
                <Activity aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarNavigationLink href={`${root}/general` as Route} label="General">
                <Settings2 aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
    </>
  )
}
