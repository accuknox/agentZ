import type { Route } from "next"
import { headers } from "next/headers"
import { notFound, permanentRedirect, redirect } from "next/navigation"
import { AdministrationLayout, AdministrationState } from "@/components/administration"
import { AppShell } from "@/components/blocks/app-shell"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
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
                  ? "Your organization membership is disabled."
                  : noAccessOrganization
                    ? "No role or team grants workspace access."
                    : "Your organization access was revoked."
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
              mcpConnectionCapabilities: result.workspace.mcp_connection_capabilities,
              inferencePoolCapabilities: result.workspace.inference_pool_capabilities,
              inferenceProviderCapabilities: result.workspace.inference_provider_capabilities,
              organization: result.scope.organization,
              lensCapabilities: result.workspace.observability_capabilities,
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
        <AdministrationLayout>
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
