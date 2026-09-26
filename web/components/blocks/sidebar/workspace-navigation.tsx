"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Cable,
  FolderGit2,
  LayoutDashboard,
  Lock,
  ScrollText,
  Settings2,
  ShieldCheck,
  Workflow,
  Zap,
} from "lucide-react"
import type { ReactNode } from "react"
import { ProductTour } from "@/components/blocks/tour/product-tour"
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { OrganizationAvatar } from "@/components/ui/avatar"
import { NavInference } from "./inference"
import type { WorkspacePath } from "@/data/types"
import { resourceLabels } from "@/lib/resource-labels"
import { NavLens } from "./lens"
import { SidebarNavigationLink } from "./navigation-link"
import type { SidebarScope } from "./sidebar"
import { WorkspaceSwitcher } from "./workspace-switcher"

export function WorkspaceNavigation({
  children,
  scope,
  showAgents,
  showSecrets,
  showTourButton,
  showWorkflows,
  userMenu,
}: {
  children: ReactNode
  scope: Extract<SidebarScope, { kind: "workspace" }>
  showAgents: boolean
  showSecrets: boolean
  showTourButton: boolean
  showWorkflows: boolean
  userMenu: ReactNode
}) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const { organization, workspace } = scope
  const root: WorkspacePath = `/orgs/${organization.slug}/workspaces/${workspace.slug}`
  const canAdminister = organization.superadmin || workspace.capabilities.administer
  const resources = [
    {
      href: `${root}/sandboxes`,
      label: "Sandboxes",
      icon: Box,
      visible: workspace.capabilities.sandboxes.read,
      tour: "sandboxes",
    },
    {
      href: `${root}/skills`,
      label: resourceLabels.skill.collection,
      icon: ScrollText,
      visible: workspace.capabilities.skills.read,
      tour: "skills",
    },
    {
      href: `${root}/mcps`,
      label: resourceLabels.mcp.collection,
      icon: Cable,
      visible: workspace.capabilities.mcp_connections.read,
      tour: "mcps",
    },
  ] as const
  const administration = [
    {
      href: `${root}/roles`,
      label: "Roles",
      icon: ShieldCheck,
      visible: canAdminister,
      tour: "roles",
    },
    {
      href: `${root}/event-trail`,
      label: "Event Trail",
      icon: Activity,
      visible: canAdminister,
      tour: "event-trail",
    },
  ] as const
  const destinations = [
    ...resources,
    {
      href: `${root}/inference/providers`,
      visible: workspace.capabilities.inference_providers.read,
    },
    { href: `${root}/inference/pools`, visible: workspace.capabilities.inference_pools.read },
    { href: `${root}/secrets`, visible: showSecrets },
    ...administration,
  ] as const
  // Match before filtering so denied deep links still have a way back out of settings.
  const settings = destinations.some(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  )
  const destination = workspace.capabilities.sandboxes.read
    ? (`${root}/sandboxes` as const)
    : destinations.find((item) => item.visible)?.href
  const back =
    workspace.type === "coding"
      ? (`${root}/projects` as const)
      : showAgents
        ? (`${root}/agents` as const)
        : workspace.capabilities.observability.read
          ? (`${root}/lens/traces` as const)
          : root

  return (
    <>
      <SidebarHeader className="h-[var(--workspace-topbar-height)] justify-center p-2">
        {settings ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                size="lg"
                tooltip="Back to top"
                className="group-data-[collapsible=icon]:justify-center"
              >
                <Link aria-label="Back to top" href={back} onNavigate={() => setOpenMobile(false)}>
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
      <SidebarContent className="gap-0 overflow-hidden" data-tour="navigation">
        {settings ? (
          <nav aria-label="Workspace settings" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-2 my-2 flex h-9 items-center gap-2 px-2 group-data-[collapsible=icon]:hidden">
              <OrganizationAvatar
                className="size-7"
                logo={organization.logo}
                name={organization.name}
              />
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <p className="truncate font-medium" title={workspace.name}>
                  {workspace.name}
                </p>
                <p className="text-muted-foreground truncate text-xs">Workspace settings</p>
              </div>
            </div>
            <SidebarGroup className="px-2 py-2">
              <SidebarMenu>
                {resources
                  .filter((item) => item.visible)
                  .map(({ href, label, icon: Icon, tour }) => (
                    <SidebarMenuItem key={href} data-tour={tour}>
                      <SidebarNavigationLink href={href} label={label}>
                        <Icon aria-hidden="true" />
                      </SidebarNavigationLink>
                    </SidebarMenuItem>
                  ))}
                {workspace.capabilities.inference_providers.read ||
                workspace.capabilities.inference_pools.read ? (
                  <NavInference
                    rootPath={root}
                    showProviders={workspace.capabilities.inference_providers.read}
                    showPools={workspace.capabilities.inference_pools.read}
                  />
                ) : null}
                {showSecrets ? (
                  <SidebarMenuItem data-tour="secrets">
                    <SidebarNavigationLink href={`${root}/secrets`} label="Secrets">
                      <Lock aria-hidden="true" />
                    </SidebarNavigationLink>
                  </SidebarMenuItem>
                ) : null}
                {canAdminister
                  ? administration.map(({ href, label, icon: Icon, tour }) => (
                      <SidebarMenuItem key={href} data-tour={tour}>
                        <SidebarNavigationLink href={href} label={label}>
                          <Icon aria-hidden="true" />
                        </SidebarNavigationLink>
                      </SidebarMenuItem>
                    ))
                  : null}
              </SidebarMenu>
            </SidebarGroup>
          </nav>
        ) : (
          <>
            <nav
              aria-label="Workspace"
              className="max-h-[min(50%,24rem)] min-h-0 shrink-0 overflow-x-hidden overflow-y-auto group-data-[collapsible=icon]:max-h-none group-data-[collapsible=icon]:flex-1 group-data-[collapsible=icon]:shrink"
            >
              <SidebarGroup className="px-2 py-2">
                <SidebarMenu>
                  {workspace.type === "coding" ? (
                    <SidebarMenuItem>
                      <SidebarNavigationLink href={`${root}/projects`} label="Projects">
                        <FolderGit2 aria-hidden="true" />
                      </SidebarNavigationLink>
                    </SidebarMenuItem>
                  ) : null}
                  {showAgents ? (
                    <SidebarMenuItem data-tour="agents">
                      <SidebarNavigationLink
                        href={`${root}/agents`}
                        label="Agents"
                        maxMatchDepth={2}
                      >
                        <Bot aria-hidden="true" />
                      </SidebarNavigationLink>
                    </SidebarMenuItem>
                  ) : null}
                  {workspace.capabilities.observability.read ? <NavLens rootPath={root} /> : null}
                  {showWorkflows ? (
                    <>
                      <SidebarMenuItem data-tour="workflows">
                        <SidebarNavigationLink
                          href={`${root}/workflows/graphs`}
                          match={
                            pathname.includes("/workflows/triggers")
                              ? undefined
                              : `${root}/workflows`
                          }
                          label={resourceLabels.workflow.collection}
                        >
                          <Workflow aria-hidden="true" />
                        </SidebarNavigationLink>
                      </SidebarMenuItem>
                      <SidebarMenuItem data-tour="triggers">
                        <SidebarNavigationLink href={`${root}/workflows/triggers`} label="Triggers">
                          <Zap aria-hidden="true" />
                        </SidebarNavigationLink>
                      </SidebarMenuItem>
                      <SidebarMenuItem data-tour="dashboards">
                        <SidebarNavigationLink href={`${root}/dashboards`} label="Dashboards">
                          <LayoutDashboard aria-hidden="true" />
                        </SidebarNavigationLink>
                      </SidebarMenuItem>
                    </>
                  ) : null}
                  {destination ? (
                    <SidebarMenuItem data-tour="workspace-settings">
                      <SidebarNavigationLink href={destination} label="Workspace settings">
                        <Settings2 aria-hidden="true" />
                      </SidebarNavigationLink>
                    </SidebarMenuItem>
                  ) : null}
                </SidebarMenu>
              </SidebarGroup>
            </nav>
            {children}
          </>
        )}
      </SidebarContent>
      {userMenu ? (
        <SidebarFooter className="border-t p-2">
          {showTourButton ? (
            <SidebarMenu className="hidden md:block">
              <SidebarMenuItem>
                <ProductTour scope={settings ? "workspace-settings" : "workspace"} />
              </SidebarMenuItem>
            </SidebarMenu>
          ) : null}
          {userMenu}
        </SidebarFooter>
      ) : null}
    </>
  )
}
