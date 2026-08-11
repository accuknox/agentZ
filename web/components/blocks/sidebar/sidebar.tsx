import type { Route } from "next"
import {
  Activity,
  Box,
  Bot,
  Brain,
  Building2,
  Cable,
  CircleUserRound,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Network,
  ScrollText,
  Search,
  Settings2,
  Share2,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  UsersRound,
} from "lucide-react"
import { NavAgents } from "./agents"
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
  | { kind: "no-access"; organization: OrganizationSummary }
  | ({ kind: "organization" } & WorkspaceNavigationScope)
  | ({
      kind: "workspace"
      apiKeyCapabilities: ResourceCapabilities
      workspace: Workspace
      observabilityCapabilities: ResourceCapabilities
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
        <WorkspaceSwitcher scope={scope} />
      </SidebarHeader>
      <SidebarContent className="gap-0">
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
          <>
            <WorkspaceNavigation
              apiKeyCapabilities={scope.apiKeyCapabilities}
              mcpConnectionCapabilities={scope.mcpConnectionCapabilities}
              inferencePoolCapabilities={scope.inferencePoolCapabilities}
              inferenceProviderCapabilities={scope.inferenceProviderCapabilities}
              organization={scope.organization}
              observabilityCapabilities={scope.observabilityCapabilities}
              skillCapabilities={scope.skillCapabilities}
              sandboxCapabilities={scope.sandboxCapabilities}
              workspace={scope.workspace}
            />
            <WorkspaceRuntimeNavigation
              organization={scope.organization}
              workspace={scope.workspace}
            />
          </>
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
  apiKeyCapabilities,
  mcpConnectionCapabilities,
  inferencePoolCapabilities,
  inferenceProviderCapabilities,
  organization,
  observabilityCapabilities,
  skillCapabilities,
  sandboxCapabilities,
  workspace,
}: {
  apiKeyCapabilities: ResourceCapabilities
  mcpConnectionCapabilities: ResourceCapabilities
  inferencePoolCapabilities: ResourceCapabilities
  inferenceProviderCapabilities: ResourceCapabilities
  organization: OrganizationSummary
  observabilityCapabilities: ResourceCapabilities
  skillCapabilities: ResourceCapabilities
  sandboxCapabilities: ResourceCapabilities
  workspace: Workspace
}) {
  const hasResources =
    observabilityCapabilities.read ||
    skillCapabilities.read ||
    mcpConnectionCapabilities.read ||
    sandboxCapabilities.read ||
    inferenceProviderCapabilities.read ||
    inferencePoolCapabilities.read

  return (
    <>
      <SidebarGroup className="px-2 py-2">
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarNavigationLink
              exact
              href={`/orgs/${organization.slug}/workspaces/${workspace.slug}` as Route}
              label="Overview"
            >
              <LayoutDashboard aria-hidden="true" />
            </SidebarNavigationLink>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarNavigationLink
              href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/agents` as Route}
              label="Agents"
            >
              <Bot aria-hidden="true" />
            </SidebarNavigationLink>
          </SidebarMenuItem>
          {apiKeyCapabilities.read ? (
            <SidebarMenuItem>
              <SidebarNavigationLink
                href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/api-keys` as Route}
                label="API Keys"
              >
                <KeyRound aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
          ) : null}
          {organization.superadmin || workspace.can_administer ? (
            <>
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/roles` as Route}
                  label="Roles"
                >
                  <ShieldCheck aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/audit` as Route}
                  label="Audit"
                >
                  <Activity aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            </>
          ) : null}
        </SidebarMenu>
      </SidebarGroup>
      {hasResources ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarMenu>
            {observabilityCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  label="Observability"
                  match={`/orgs/${organization.slug}/workspaces/${workspace.slug}/observability`}
                  href={
                    `/orgs/${organization.slug}/workspaces/${workspace.slug}/observability/traces` as Route
                  }
                >
                  <Search aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {skillCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/skills` as Route}
                  label="Skills"
                >
                  <ScrollText aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {mcpConnectionCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`/orgs/${organization.slug}/workspaces/${workspace.slug}/mcps` as Route}
                  label="MCP"
                >
                  <Cable aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {sandboxCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={
                    `/orgs/${organization.slug}/workspaces/${workspace.slug}/sandboxes` as Route
                  }
                  label="Sandboxes"
                >
                  <Box aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {inferenceProviderCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={
                    `/orgs/${organization.slug}/workspaces/${workspace.slug}/inference/providers` as Route
                  }
                  label="Providers"
                >
                  <Brain aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {inferencePoolCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={
                    `/orgs/${organization.slug}/workspaces/${workspace.slug}/inference/pools` as Route
                  }
                  label="Pools"
                >
                  <Layers3 aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {organization.superadmin ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarNavigationLink
                href={
                  `/orgs/${organization.slug}/workspaces/${workspace.slug}/settings/inherited` as Route
                }
                label="Inherited Resources"
              >
                <Share2 aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarNavigationLink
                href={
                  `/orgs/${organization.slug}/workspaces/${workspace.slug}/settings/delete` as Route
                }
                label="Delete Workspace"
              >
                <Trash2 aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
    </>
  )
}

async function WorkspaceRuntimeNavigation({
  organization,
  workspace,
}: {
  organization: OrganizationSummary
  workspace: Workspace
}) {
  const [agents, sandboxes, skills] = await Promise.all([
    listAgentsCachedQuery(undefined, workspace.id),
    listSandboxesCachedQuery({ limit: 50 }, workspace.id),
    listImmutableSkillsCachedQuery(workspace.id),
  ])
  const workspacePath = `/orgs/${organization.slug}/workspaces/${workspace.slug}` as Route

  return (
    <>
      <SidebarGroup className="gap-y-1 px-2 py-2">
        <NavSecrets workspacePath={workspacePath} />
        <NavWorkflows workspacePath={workspacePath} />
      </SidebarGroup>
      <SidebarGroup className="px-2 py-2">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <NavAgents
          agents={agents}
          immutableSkills={skills.skills ?? []}
          sandboxes={sandboxes}
          workspaceId={workspace.id}
          workspacePath={workspacePath}
        />
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
                <SidebarMenuItem>
                  <SidebarNavigationLink href={`${root}/access` as Route} label="Access">
                    <Network aria-hidden="true" />
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
                  label="Providers"
                >
                  <Brain aria-hidden="true" />
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
              <SidebarNavigationLink href={`${root}/audit` as Route} label="Audit">
                <Activity aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarNavigationLink
                href={`${root}/destructive-operations` as Route}
                label="Operations"
              >
                <Trash2 aria-hidden="true" />
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
