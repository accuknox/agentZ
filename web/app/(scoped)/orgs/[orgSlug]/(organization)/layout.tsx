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
  if (result.kind === "forbidden") {
    const { organizationSession } = result
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
            <AdministrationState kind="forbidden" />
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
  const tabs = result.organization.superadmin
    ? ([
        { href: `${root}/workspaces` as Route, label: "Workspaces" },
        { href: `${root}/teams` as Route, label: "Teams" },
        { href: `${root}/roles` as Route, label: "Roles" },
        { href: `${root}/audit` as Route, label: "Audit" },
        { href: `${root}/general` as Route, label: "General" },
      ] as const satisfies readonly RouteTab[])
    : []

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
              organization: result.organization,
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
