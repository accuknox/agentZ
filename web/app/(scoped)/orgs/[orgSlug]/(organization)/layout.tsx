import type { Route } from "next"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { AdministrationLayout, AdministrationState } from "@/components/administration"
import { AppShell } from "@/components/blocks/app-shell"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
import { ThemeSync } from "@/components/theme-sync"
import {
  activateOrganization,
  scheduleOrganizationRouteMemory,
  resolveOrganizationSlug,
} from "@/data/organizations"
import { getCurrentUserPreferences } from "@/data/user-preferences"
import { getWorkspaceDirectory } from "@/data/workspaces"
import { ensureTenant } from "@/lib/gateway/client/sdk.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"

export const unstable_instant = false

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}): Promise<Metadata> {
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  const name = result.kind === "ready" ? result.organization.name : "Organisation"
  return {
    title: {
      default: name,
      template: `${name} - %s | AgentZ`,
    },
  }
}

export default async function OrganizationLayout({
  children,
  params,
}: {
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
              activeOrganizationId={organizationSession.activeOrganizationId}
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
                  ? "Your organization membership is disabled."
                  : "Your organization access was revoked."
              }
              kind="forbidden"
              title={disabled ? "Organisation Membership disabled" : "Access revoked"}
            />
          </div>
        </AppShell>
      </>
    )
  }

  if (result.kind === "zero-access") {
    return (
      <>
        <ThemeSync theme={preferences.theme} />
        <AppShell
          sidebar={
            <AppSidebar
              activeOrganizationId={result.organizationSession.activeOrganizationId}
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
              description="You joined this organisation, but no role or team grants product access yet."
              kind="forbidden"
              title="Access not assigned"
            />
          </div>
        </AppShell>
      </>
    )
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
    redirect(`/orgs/${result.organization.slug}/setting-up` as Route)
  }

  const workspaceResult = await getWorkspaceDirectory(result.organization.slug)
  if (!workspaceResult.directory) {
    throw new Error("workspace directory unavailable after organisation resolution")
  }

  const root = `/orgs/${result.organization.slug}`
  const requestHeaders = await headers()
  const requestedPath = requestHeaders.get("x-agentz-pathname") ?? root
  const requestedURL = new URL(requestedPath, "http://agentz.local")
  const rememberedPath = requestedURL.pathname.startsWith(`${root}/event-trail/`)
    ? `${root}/event-trail`
    : requestedURL.pathname
  if (rememberedPath !== root) {
    await scheduleOrganizationRouteMemory(result.organization.id, rememberedPath, null)
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
        <AdministrationLayout>{children}</AdministrationLayout>
      </AppShell>
    </>
  )
}
