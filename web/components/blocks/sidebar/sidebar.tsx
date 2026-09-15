import Link from "next/link"
import { Suspense } from "react"
import {
  Activity,
  ArrowLeft,
  Box,
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
import { ProductTour } from "@/components/blocks/tour/product-tour"
import { NavSessions, NavSessionsSkeleton } from "./sessions"
import { WorkspaceNavigation } from "./workspace-navigation"
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
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import type { OrganizationSummary } from "@/data/organizations"
import type { ListAgentActionResponse, WorkspacePath } from "@/data/types"
import type { ChatSessionPreference, ResourceCapabilities, Workspace } from "@/lib/gateway/client"
import { resourceLabels } from "@/lib/resource-labels"
import { getChatSessionPreference, listChatSessions } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"

type WorkspaceNavigationScope = {
  canCreateWorkspace: boolean
  canEnterOrganization: boolean
  organization: OrganizationSummary
  workspaces: Workspace[]
}

export type SidebarScope =
  | { kind: "account" }
  | { kind: "settings"; hasAppDestination: boolean }
  | { kind: "no-access"; organization: OrganizationSummary }
  | ({
      kind: "organization"
      mcpConnectionCapabilities: ResourceCapabilities
      inferenceProviderCapabilities: ResourceCapabilities
      sandboxCapabilities: ResourceCapabilities
      skillCapabilities: ResourceCapabilities
    } & WorkspaceNavigationScope)
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
  showTourButton?: boolean
}

export function AppSidebar({
  activeOrganizationId,
  organizations = [],
  scope,
  showTourButton = false,
  user,
  ...sidebarProps
}: AppSidebarProps) {
  const userMenu = user ? (
    <NavUser
      activeOrganizationId={activeOrganizationId}
      organizations={organizations}
      user={user}
    />
  ) : null

  if (scope.kind === "workspace" && scope.workspace.state === "ready") {
    return (
      <Sidebar collapsible="icon" data-app-sidebar {...sidebarProps}>
        <WorkspaceSidebar scope={scope} showTourButton={showTourButton} userMenu={userMenu} />
        <SidebarRail />
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="icon" data-app-sidebar {...sidebarProps}>
      <SidebarHeader className="h-[var(--workspace-topbar-height)] justify-center p-2">
        {scope.kind === "settings" && scope.hasAppDestination ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="group-data-[collapsible=icon]:justify-center"
                size="lg"
                tooltip="Back to top"
              >
                <Link aria-label="Back to top" href="/">
                  <ArrowLeft aria-hidden="true" />
                  <span className="group-data-[collapsible=icon]:hidden">Back to top</span>
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
      </SidebarContent>
      {user ? (
        <SidebarFooter className="border-t p-2">
          {showTourButton && scope.kind === "organization" ? (
            <SidebarMenu className="hidden md:block">
              <SidebarMenuItem>
                <ProductTour scope={scope.kind} />
              </SidebarMenuItem>
            </SidebarMenu>
          ) : null}
          {userMenu}
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
          <SidebarNavigationLink href="/settings/api-keys" label="API keys">
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

async function WorkspaceSidebar({
  scope,
  showTourButton,
  userMenu,
}: {
  scope: Extract<SidebarScope, { kind: "workspace" }>
  showTourButton: boolean
  userMenu: React.ReactNode
}) {
  const { organization, workspace } = scope
  const workspacePath: WorkspacePath = `/orgs/${organization.slug}/workspaces/${workspace.slug}`
  const agents = await listAllAgentsCachedQuery(workspace.id)
  const showAgents = workspace.capabilities.agents.author || (agents.agents?.length ?? 0) > 0
  const showSecrets =
    agents.agents?.some(
      (agent) =>
        agent.capabilities.read_secrets ||
        agent.capabilities.write_secrets ||
        agent.capabilities.delete_secrets
    ) ?? false
  const showWorkflows =
    workspace.type !== "coding" && (agents.agents?.some((agent) => agent.capabilities.use) ?? false)
  let chatSessions: React.JSX.Element | null = null
  if (showAgents) {
    const preference = await getChatSessionPreference({
      client: getGatewayServerClient(workspace.id),
    })
    if (preference.error) {
      throw new Error("Failed to load chat preferences")
    }
    chatSessions = (
      <SidebarGroup className="min-h-0 flex-1 px-0 py-1 group-data-[collapsible=icon]:hidden">
        <Suspense
          fallback={
            <NavSessionsSkeleton
              groupBy={preference.data.group_by}
              coding={workspace.type === "coding"}
            />
          }
        >
          <WorkspaceChatSessions
            agents={agents}
            preferences={preference.data}
            workspaceId={workspace.id}
            workspaceType={workspace.type}
            workspacePath={workspacePath}
          />
        </Suspense>
      </SidebarGroup>
    )
  }

  return (
    <WorkspaceNavigation
      scope={scope}
      showAgents={showAgents}
      showSecrets={showSecrets}
      showTourButton={showTourButton}
      showWorkflows={showWorkflows}
      userMenu={userMenu}
    >
      {chatSessions}
    </WorkspaceNavigation>
  )
}

async function WorkspaceChatSessions({
  agents,
  preferences,
  workspaceId,
  workspaceType,
  workspacePath,
}: {
  agents: ListAgentActionResponse
  preferences: ChatSessionPreference
  workspaceType: Workspace["type"]
  workspaceId: string
  workspacePath: WorkspacePath
}) {
  const [sessions, actor] = await Promise.all([
    listChatSessions({
      client: getGatewayServerClient(workspaceId),
      query: {
        agent_name: preferences.agent_name ?? undefined,
        group_by: preferences.group_by,
        include_workflow_runs: preferences.include_workflow_runs,
        limit: 10,
        participant_user_id:
          preferences.participant_user_ids.length > 0
            ? preferences.participant_user_ids
            : undefined,
        time_zone: preferences.group_by === "date" ? "UTC" : undefined,
      },
    }),
    currentGatewayAuthContext(),
  ])
  if (sessions.error) {
    throw new Error("Failed to load chat sessions")
  }

  return (
    <NavSessions
      userId={actor.userId}
      agents={agents}
      initialPreferences={preferences}
      initialSessions={sessions.data}
      workspaceType={workspaceType}
      workspaceId={workspaceId}
      workspacePath={workspacePath}
    />
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
  const root = `/orgs/${organization.slug}` as const
  const hasResources =
    skillCapabilities.read ||
    mcpConnectionCapabilities.read ||
    sandboxCapabilities.read ||
    inferenceProviderCapabilities.read

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tour="navigation">
      {canEnterOrganization || organization.superadmin ? (
        <SidebarGroup className="px-2 py-2">
          <SidebarGroupLabel>Organization</SidebarGroupLabel>
          <SidebarMenu>
            {canEnterOrganization ? (
              <SidebarMenuItem data-tour="workspaces">
                <SidebarNavigationLink href={`${root}/workspaces`} label="Workspaces">
                  <Building2 aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {organization.superadmin ? (
              <>
                <SidebarMenuItem data-tour="users">
                  <SidebarNavigationLink
                    href={`${root}/users/status/active`}
                    label="Users"
                    match={`${root}/users`}
                  >
                    <CircleUserRound aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
                <SidebarMenuItem data-tour="teams">
                  <SidebarNavigationLink href={`${root}/teams`} label="Teams">
                    <UsersRound aria-hidden="true" />
                  </SidebarNavigationLink>
                </SidebarMenuItem>
                <SidebarMenuItem data-tour="roles">
                  <SidebarNavigationLink href={`${root}/roles`} label="Roles">
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
              <SidebarMenuItem data-tour="skills">
                <SidebarNavigationLink
                  href={`${root}/skills`}
                  label={resourceLabels.skill.collection}
                >
                  <ScrollText aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {mcpConnectionCapabilities.read ? (
              <SidebarMenuItem data-tour="mcps">
                <SidebarNavigationLink href={`${root}/mcps`} label={resourceLabels.mcp.collection}>
                  <Cable aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {sandboxCapabilities.read ? (
              <SidebarMenuItem data-tour="sandboxes">
                <SidebarNavigationLink href={`${root}/sandboxes`} label="Sandboxes">
                  <Box aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {inferenceProviderCapabilities.read ? (
              <SidebarMenuItem data-tour="inference">
                <SidebarNavigationLink
                  href={`${root}/inference/providers`}
                  label={resourceLabels.inference.collection}
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
            <SidebarMenuItem data-tour="social-admission">
              <SidebarNavigationLink href={`${root}/social-admission`} label="Social admission">
                <UserRoundCheck aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem data-tour="event-trail">
              <SidebarNavigationLink href={`${root}/event-trail`} label="Event trail">
                <Activity aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem data-tour="general">
              <SidebarNavigationLink href={`${root}/general`} label="General">
                <Settings2 aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
    </div>
  )
}
