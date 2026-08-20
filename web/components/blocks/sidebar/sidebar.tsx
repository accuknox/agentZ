import type { Route } from "next"
import Link from "next/link"
import {
  Activity,
  ArrowLeft,
  Box,
  Bot,
  Building2,
  Cable,
  ChevronDown,
  CircleUserRound,
  CloudCog,
  Folder,
  KeyRound,
  Monitor,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  User2,
  UserRoundCheck,
  UsersRound,
  Workflow,
  Zap,
} from "lucide-react"
import { NavSessions } from "./sessions"
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
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import { NavSecrets } from "./secrets"
import type { OrganizationSummary } from "@/data/organizations"
import type { WorkspacePath } from "@/data/types"
import type { ResourceCapabilities, Workspace } from "@/lib/gateway/client"
import { resourceLabels } from "@/lib/resource-labels"
import { getChatSessionPreference, listChatSessions } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

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
    <Sidebar collapsible="icon" data-app-sidebar {...sidebarProps}>
      <SidebarHeader className="h-[var(--workspace-topbar-height)] justify-center p-2">
        {scope.kind === "settings" && scope.hasAppDestination ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip="Back to top">
                <Link href="/">
                  <ArrowLeft aria-hidden="true" />
                  <span>Back to top</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : (
          <WorkspaceSwitcher scope={scope} />
        )}
      </SidebarHeader>
      <SidebarContent className={scope.kind === "workspace" ? "gap-0 overflow-hidden" : "gap-0"}>
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
  const workspacePath: WorkspacePath = `/orgs/${organization.slug}/workspaces/${workspace.slug}`
  const agents = await listAllAgentsCachedQuery(workspace.id)
  const hasAgents = agents.error === undefined && agents.agents.length > 0
  const showSecrets =
    agents.error === undefined &&
    agents.agents.some(
      (agent) =>
        agent.capabilities.read_secrets ||
        agent.capabilities.write_secrets ||
        agent.capabilities.delete_secrets
    )
  const showWorkflows =
    agents.error === undefined && agents.agents.some((agent) => agent.capabilities.use)
  const showAgents = workspace.capabilities.agents.author || hasAgents
  const hasResources =
    lensCapabilities.read ||
    skillCapabilities.read ||
    mcpConnectionCapabilities.read ||
    sandboxCapabilities.read ||
    inferenceProviderCapabilities.read ||
    inferencePoolCapabilities.read ||
    showSecrets ||
    showWorkflows
  const hasWorkspace = showAgents || organization.superadmin || workspace.capabilities.administer

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <details className="group/tools shrink-0 px-[var(--sidebar-content-inset)] pb-1 group-data-[collapsible=icon]:hidden">
        <summary className="hover:bg-sidebar-row-hover flex h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <Folder aria-hidden="true" className="text-muted-foreground size-4" />
          <span className="min-w-0 flex-1 truncate">Workspace</span>
          <ChevronDown
            aria-hidden="true"
            className="text-muted-foreground size-4 transition-transform group-open/tools:rotate-180"
          />
        </summary>
        <div className="no-scrollbar max-h-[min(42dvh,24rem)] overflow-y-auto pt-1">
          {hasResources ? (
            <SidebarGroup className="px-0 py-0">
              <SidebarMenu>
                {lensCapabilities.read ? <NavLens rootPath={workspacePath} /> : null}
                {skillCapabilities.read ? (
                  <SidebarMenuItem>
                    <SidebarNavigationLink
                      href={`${workspacePath}/skills` as Route}
                      label={resourceLabels.skill.collection}
                    >
                      <ScrollText aria-hidden="true" />
                    </SidebarNavigationLink>
                  </SidebarMenuItem>
                ) : null}
                {mcpConnectionCapabilities.read ? (
                  <SidebarMenuItem>
                    <SidebarNavigationLink
                      href={`${workspacePath}/mcps` as Route}
                      label={resourceLabels.mcp.collection}
                    >
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
                {showSecrets ? <NavSecrets workspacePath={workspacePath} /> : null}
                {showWorkflows ? (
                  <>
                    <SidebarMenuItem>
                      <SidebarNavigationLink
                        href={`${workspacePath}/workflows/graphs` as Route}
                        label={resourceLabels.workflow.collection}
                      >
                        <Workflow aria-hidden="true" />
                      </SidebarNavigationLink>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarNavigationLink
                        href={`${workspacePath}/workflows/triggers` as Route}
                        label="Triggers"
                      >
                        <Zap aria-hidden="true" />
                      </SidebarNavigationLink>
                    </SidebarMenuItem>
                  </>
                ) : null}
              </SidebarMenu>
            </SidebarGroup>
          ) : null}
          {hasWorkspace ? (
            <SidebarGroup className="px-0 py-1">
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarMenu>
                {showAgents ? (
                  <SidebarMenuItem>
                    <SidebarNavigationLink href={`${workspacePath}/agents` as Route} label="Agents">
                      <Bot aria-hidden="true" />
                    </SidebarNavigationLink>
                  </SidebarMenuItem>
                ) : null}
                {organization.superadmin || workspace.capabilities.administer ? (
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
        </div>
      </details>
      {showAgents ? (
        <ChatSessionNavigation
          agents={agents}
          workspaceId={workspace.id}
          workspacePath={workspacePath}
        />
      ) : null}
    </div>
  )
}

async function ChatSessionNavigation({
  agents,
  workspaceId,
  workspacePath,
}: {
  agents: Awaited<ReturnType<typeof listAllAgentsCachedQuery>>
  workspaceId: string
  workspacePath: WorkspacePath
}) {
  const client = getGatewayServerClient(workspaceId)
  const preference = await getChatSessionPreference({ client })
  if (preference.error) {
    throw new Error("Failed to load chat preferences")
  }
  const sessions = await listChatSessions({
    client,
    query: {
      agent_name: preference.data.agent_name ?? undefined,
      include_workflow_runs: preference.data.include_workflow_runs,
      limit: 10,
      participant_user_id:
        preference.data.participant_user_ids.length > 0
          ? preference.data.participant_user_ids
          : undefined,
    },
  })
  if (sessions.error) {
    throw new Error("Failed to load chat sessions")
  }

  return (
    <SidebarGroup className="min-h-0 flex-1 px-0 py-1">
      <NavSessions
        agents={agents}
        initialPreferences={preference.data}
        initialSessions={sessions.data}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
      />
    </SidebarGroup>
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
          <SidebarGroupLabel>Organization</SidebarGroupLabel>
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
                  <SidebarNavigationLink
                    href={`${root}/users/status/active` as Route}
                    label="Users"
                    match={`${root}/users`}
                  >
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
                <SidebarNavigationLink
                  href={`${root}/skills` as Route}
                  label={resourceLabels.skill.collection}
                >
                  <ScrollText aria-hidden="true" />
                </SidebarNavigationLink>
              </SidebarMenuItem>
            ) : null}
            {mcpConnectionCapabilities.read ? (
              <SidebarMenuItem>
                <SidebarNavigationLink
                  href={`${root}/mcps` as Route}
                  label={resourceLabels.mcp.collection}
                >
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
            <SidebarMenuItem>
              <SidebarNavigationLink
                href={`${root}/social-admission` as Route}
                label="Social admission"
              >
                <UserRoundCheck aria-hidden="true" />
              </SidebarNavigationLink>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarNavigationLink href={`${root}/event-trail` as Route} label="Event trail">
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
