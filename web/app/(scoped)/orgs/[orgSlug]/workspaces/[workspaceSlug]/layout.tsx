import type { Route } from "next"
import { headers } from "next/headers"
import { notFound, permanentRedirect, redirect } from "next/navigation"
import { AdministrationLayout, AdministrationState } from "@/components/administration"
import { AppShell } from "@/components/blocks/app-shell"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { ThemeSync } from "@/components/theme-sync"
import { rememberOrganizationRoute } from "@/data/organizations"
import { getCurrentUserPreferences } from "@/data/user-preferences"
import { getWorkspaceScope } from "@/data/workspaces"
import { signInURL } from "@/lib/sign-in-redirect"
import { WorkspaceState } from "./workspace-state"

export const unstable_instant = false

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const result = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (result.scope.kind === "unauthorized") {
    redirect(signInURL({ returnTo: `/orgs/${orgSlug}/workspaces/${workspaceSlug}` }))
  }
  if (result.scope.kind === "not-found" || result.kind === "not-found") {
    notFound()
  }

  const preferences = await getCurrentUserPreferences()
  if (
    result.scope.kind === "forbidden" ||
    result.scope.kind === "disabled" ||
    (result.scope.kind === "ready" && !result.scope.organization.hasAccess)
  ) {
    const { organizationSession } = result.scope
    const disabled = result.scope.kind === "disabled"
    const noAccessOrganization =
      result.scope.kind === "ready" ? result.scope.organization : undefined
    return (
      <>
        <ThemeSync theme={preferences.theme} />
        <AppShell
          sidebar={
            <AppSidebar
              activeOrganizationId={organizationSession.session.session.activeOrganizationId}
              organizations={organizationSession.organizations}
              scope={
                noAccessOrganization
                  ? { kind: "no-access", organization: noAccessOrganization }
                  : { kind: "account" }
              }
              user={{
                email: organizationSession.session.user.email,
                image: organizationSession.session.user.image,
                name: organizationSession.session.user.name,
              }}
            />
          }
        >
          <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
            <AdministrationState
              description={
                disabled
                  ? "Your Organisation Membership is disabled. Product resources remain unavailable."
                  : noAccessOrganization
                    ? "Your Organisation Membership is active, but no Role or Team currently grants workspace access."
                    : "Your Organisation access was revoked. Choose another accessible Organisation."
              }
              kind={noAccessOrganization ? "empty" : "forbidden"}
              title={
                disabled
                  ? "Organisation Membership disabled"
                  : noAccessOrganization
                    ? "Access not assigned"
                    : "Access revoked"
              }
            />
          </div>
        </AppShell>
      </>
    )
  }
  if (result.kind !== "ready") {
    notFound()
  }

  const requestHeaders = await headers()
  const requestedPath =
    requestHeaders.get("x-agentz-pathname") ?? `/orgs/${orgSlug}/workspaces/${workspaceSlug}`
  const requestedURL = new URL(requestedPath, "http://agentz.local")
  if (result.scope.retired || result.retired) {
    const prefix = `/orgs/${orgSlug}/workspaces/${workspaceSlug}`
    const canonical =
      `/orgs/${result.scope.organization.slug}/workspaces/${result.workspace.slug}` as const
    requestedURL.pathname = `${canonical}${requestedURL.pathname.slice(prefix.length)}`
    permanentRedirect(`${requestedURL.pathname}${requestedURL.search}` as Route)
  }

  await rememberOrganizationRoute(
    result.scope.organization.id,
    requestedURL.pathname,
    result.workspace.id
  )

  const root = `/orgs/${result.scope.organization.slug}/workspaces/${result.workspace.slug}`
  const tabs: RouteTab[] = [
    { href: root as Route, label: "Overview" },
    { href: `${root}/agents` as Route, label: "Agents" },
  ]
  if (result.workspace.api_key_capabilities.read) {
    tabs.push({ href: `${root}/api-keys` as Route, label: "API Keys" })
  }
  if (result.scope.organization.superadmin || result.workspace.can_administer) {
    tabs.push(
      { href: `${root}/roles` as Route, label: "Roles" },
      { href: `${root}/audit` as Route, label: "Audit" }
    )
  }
  if (result.scope.organization.superadmin) {
    tabs.push(
      {
        href: `${root}/settings/inherited` as Route,
        label: "Inherited Resources",
      },
      { href: `${root}/settings/delete` as Route, label: "Delete Workspace" }
    )
  }
  if (result.workspace.skill_capabilities.read) {
    tabs.push({ href: `${root}/skills` as Route, label: "Skills" })
  }
  if (result.workspace.mcp_connection_capabilities.read) {
    tabs.push({ href: `${root}/mcps` as Route, label: "MCP" })
  }
  if (result.workspace.sandbox_capabilities.read) {
    tabs.push({ href: `${root}/sandboxes` as Route, label: "Sandboxes" })
  }
  if (result.workspace.inference_provider_capabilities.read) {
    tabs.push({ href: `${root}/inference/providers` as Route, label: "Providers" })
  }
  if (result.workspace.inference_pool_capabilities.read) {
    tabs.push({ href: `${root}/inference/pools` as Route, label: "Pools" })
  }
  if (result.workspace.observability_capabilities.read) {
    tabs.push({ href: `${root}/observability/traces` as Route, label: "Observability" })
  }

  return (
    <>
      <ThemeSync theme={preferences.theme} />
      <AppShell
        breadcrumbLabels={{
          1: result.scope.organization.name,
          3: result.workspace.name,
        }}
        sidebar={
          <AppSidebar
            activeOrganizationId={result.scope.organization.id}
            organizations={result.scope.organizationSession.organizations}
            scope={{
              canCreateWorkspace: result.directory.can_create,
              canEnterOrganization: result.directory.can_enter_organization,
              kind: "workspace",
              apiKeyCapabilities: result.workspace.api_key_capabilities,
              mcpConnectionCapabilities: result.workspace.mcp_connection_capabilities,
              inferencePoolCapabilities: result.workspace.inference_pool_capabilities,
              inferenceProviderCapabilities: result.workspace.inference_provider_capabilities,
              organization: result.scope.organization,
              observabilityCapabilities: result.workspace.observability_capabilities,
              sandboxCapabilities: result.workspace.sandbox_capabilities,
              skillCapabilities: result.workspace.skill_capabilities,
              workspace: result.workspace,
              workspaces: result.directory.workspaces,
            }}
            user={{
              email: result.scope.organizationSession.session.user.email,
              image: result.scope.organizationSession.session.user.image,
              name: result.scope.organizationSession.session.user.name,
            }}
          />
        }
      >
        <AdministrationLayout
          description="Manage resources and access within this Workspace."
          navigation={<RouteTabs label="Workspace navigation" tabs={tabs} />}
          scope={{
            kind: "Workspace",
            name: result.workspace.name,
            organisationName: result.scope.organization.name,
          }}
          status={result.workspace.state}
        >
          {result.workspace.state === "ready" ? (
            children
          ) : (
            <WorkspaceState
              canRetry={result.scope.organization.superadmin}
              orgSlug={result.scope.organization.slug}
              workspace={result.workspace}
            />
          )}
        </AdministrationLayout>
      </AppShell>
    </>
  )
}
