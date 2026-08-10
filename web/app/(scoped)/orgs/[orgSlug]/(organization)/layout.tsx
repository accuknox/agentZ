import type { Route } from "next"
import { headers } from "next/headers"
import { notFound, permanentRedirect, redirect } from "next/navigation"
import { AdministrationLayout, AdministrationState } from "@/components/administration"
import { AppShell } from "@/components/blocks/app-shell"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { ThemeSync } from "@/components/theme-sync"
import {
  activateOrganization,
  rememberOrganizationRoute,
  resolveOrganizationSlug,
} from "@/data/organizations"
import { getCurrentUserPreferences } from "@/data/user-preferences"
import { getWorkspaceDirectory } from "@/data/workspaces"
import { ensureTenant } from "@/lib/gateway/client/sdk.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"

export const unstable_instant = false

export default async function OrganizationLayout({
  auditEvent,
  children,
  params,
}: {
  auditEvent: React.ReactNode
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind === "unauthorized") {
    redirect(signInURL({ returnTo: `/orgs/${orgSlug}` }))
  }
  if (result.kind === "not-found") {
    notFound()
  }

  const preferences = await getCurrentUserPreferences()
  if (result.kind === "forbidden" || result.kind === "disabled") {
    const { organizationSession } = result
    const disabled = result.kind === "disabled"
    return (
      <>
        <ThemeSync theme={preferences.theme} />
        <AppShell
          sidebar={
            <AppSidebar
              activeOrganizationId={organizationSession.session.session.activeOrganizationId}
              organizations={organizationSession.organizations}
              scope={{ kind: "account" }}
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
                  ? "Your Organisation Membership is disabled. Account, Sessions, Preferences, and other accessible Organisations remain available."
                  : "Your Organisation access was revoked. Choose another accessible Organisation or use account settings."
              }
              kind="forbidden"
              title={disabled ? "Organisation Membership disabled" : "Access revoked"}
            />
          </div>
        </AppShell>
      </>
    )
  }

  const requestHeaders = await headers()
  const requestedPath = requestHeaders.get("x-agentz-pathname") ?? `/orgs/${orgSlug}`
  const requestedURL = new URL(requestedPath, "http://agentz.local")
  if (result.retired) {
    const prefix = `/orgs/${orgSlug}`
    requestedURL.pathname = `/orgs/${result.organization.slug}${requestedURL.pathname.slice(prefix.length)}`
    permanentRedirect(`${requestedURL.pathname}${requestedURL.search}` as Route)
  }

  await activateOrganization(result.organization.id)
  if (!result.organization.hasAccess) {
    return (
      <>
        <ThemeSync theme={preferences.theme} />
        <AppShell
          sidebar={
            <AppSidebar
              activeOrganizationId={result.organization.id}
              organizations={result.organizationSession.organizations}
              scope={{ kind: "no-access", organization: result.organization }}
              user={{
                email: result.organizationSession.session.user.email,
                image: result.organizationSession.session.user.image,
                name: result.organizationSession.session.user.name,
              }}
            />
          }
        >
          <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
            <AdministrationState
              description="Your Organisation Membership is active, but no Role or Team currently grants product access. Account, Sessions, Preferences, and Organisation switching remain available."
              kind="empty"
              title="Access not assigned"
            />
          </div>
        </AppShell>
      </>
    )
  }

  const tenant = await ensureTenant({
    client: getGatewayServerClient(),
    throwOnError: true,
  })
  if (!tenant.data) {
    throw new Error("gateway returned no tenant bootstrap state")
  }
  if (!tenant.data.ready) {
    redirect("/setting-up")
  }

  const workspaceResult = await getWorkspaceDirectory(result.organization.slug)
  if (!workspaceResult.directory) {
    throw new Error("workspace directory unavailable after organisation resolution")
  }

  const root = `/orgs/${result.organization.slug}`
  const rememberedPath = requestedURL.pathname.startsWith(`${root}/audit/`)
    ? `${root}/audit`
    : requestedURL.pathname
  await rememberOrganizationRoute(result.organization.id, rememberedPath, null)
  const tabs: RouteTab[] = []
  if (result.organization.superadmin) {
    tabs.push(
      { href: `${root}/workspaces` as Route, label: "Workspaces" },
      { href: `${root}/users` as Route, label: "Users" },
      { href: `${root}/teams` as Route, label: "Teams" },
      { href: `${root}/roles` as Route, label: "Roles" },
      { href: `${root}/access` as Route, label: "Access" },
      { href: `${root}/social-admission` as Route, label: "Social Admission" },
      { href: `${root}/destructive-operations` as Route, label: "Destructive Ops" },
      { href: `${root}/audit` as Route, label: "Audit" },
      { href: `${root}/general` as Route, label: "General" }
    )
  }
  if (tenant.data.skill_capabilities.read) {
    tabs.push({ href: `${root}/skills` as Route, label: "Skills" })
  }
  if (tenant.data.mcp_connection_capabilities.read) {
    tabs.push({ href: `${root}/mcps` as Route, label: "MCP" })
  }
  if (tenant.data.sandbox_capabilities.read) {
    tabs.push({ href: `${root}/sandboxes` as Route, label: "Sandboxes" })
  }
  if (tenant.data.inference_provider_capabilities.read) {
    tabs.push({ href: `${root}/inference/providers` as Route, label: "Providers" })
  }

  return (
    <>
      <ThemeSync theme={preferences.theme} />
      <AppShell
        breadcrumbLabels={{ 1: result.organization.name }}
        sidebar={
          <AppSidebar
            activeOrganizationId={result.organization.id}
            organizations={result.organizationSession.organizations}
            scope={{
              canCreateWorkspace: workspaceResult.directory.can_create,
              canEnterOrganization: workspaceResult.directory.can_enter_organization,
              kind: "organization",
              mcpConnectionCapabilities: tenant.data.mcp_connection_capabilities,
              inferencePoolCapabilities: tenant.data.inference_pool_capabilities,
              inferenceProviderCapabilities: tenant.data.inference_provider_capabilities,
              organization: result.organization,
              sandboxCapabilities: tenant.data.sandbox_capabilities,
              skillCapabilities: tenant.data.skill_capabilities,
              workspaces: workspaceResult.directory.workspaces,
            }}
            user={{
              email: result.organizationSession.session.user.email,
              image: result.organizationSession.session.user.image,
              name: result.organizationSession.session.user.name,
            }}
          />
        }
      >
        <AdministrationLayout
          description="Manage this Organisation's workspaces and settings."
          navigation={
            tabs.length > 0 ? (
              <RouteTabs label="Organisation administration" tabs={tabs} />
            ) : undefined
          }
          scope={{ kind: "Organisation", name: result.organization.name }}
          status="ready"
        >
          {children}
        </AdministrationLayout>
        {auditEvent}
      </AppShell>
    </>
  )
}
