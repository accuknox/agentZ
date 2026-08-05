import { Suspense } from "react"
import { redirect } from "next/navigation"
import { AppShell, AppShellFallback } from "@/components/blocks/app-shell"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
import { ThemeSync } from "@/components/theme-sync"
import { activateOrganization, getOrganizationSession } from "@/data/organizations"
import { getCurrentUserPreferences } from "@/data/user-preferences"
import { ensureTenant } from "@/lib/gateway/client/sdk.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AppShellFallback />}>
      <AppGate>{children}</AppGate>
    </Suspense>
  )
}

async function AppGate({ children }: { children: React.ReactNode }) {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) {
    redirect("/signin")
  }

  const organization =
    organizationSession.organizations.find(
      (candidate) => candidate.id === organizationSession.session.session.activeOrganizationId
    ) ?? organizationSession.organizations[0]
  if (!organization) {
    redirect("/settings/account")
  }

  await activateOrganization(organization.id)
  const tenant = await ensureTenant({
    client: getGatewayServerClient(),
    throwOnError: true,
  })
  const tenantData = tenant.data
  if (!tenantData) {
    throw new Error("gateway returned no tenant bootstrap state")
  }

  if (!tenantData.ready) {
    redirect("/setting-up")
  }

  const preferences = await getCurrentUserPreferences()

  return (
    <>
      <ThemeSync theme={preferences.theme} />
      <AppShell
        sidebar={
          <AppSidebar
            activeOrganizationId={organization.id}
            organizations={organizationSession.organizations}
            scope={{ kind: "legacy" }}
            user={{
              email: organizationSession.session.user.email,
              image: organizationSession.session.user.image,
              name: organizationSession.session.user.name,
            }}
          />
        }
      >
        {children}
      </AppShell>
    </>
  )
}
