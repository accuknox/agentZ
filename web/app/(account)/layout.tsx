import { Suspense } from "react"
import { redirect } from "next/navigation"
import { AppShell } from "@/components/blocks/app-shell"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
import { AgentZTransition } from "@/components/scope-transition"
import { ThemeSync } from "@/components/theme-sync"
import { getOrganizationSession } from "@/data/organizations"
import { getCurrentUserPreferences } from "@/data/user-preferences"

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AgentZTransition />}>
      <AccountGate>{children}</AccountGate>
    </Suspense>
  )
}

async function AccountGate({ children }: { children: React.ReactNode }) {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) {
    redirect("/signin")
  }

  const preferences = await getCurrentUserPreferences()

  return (
    <>
      <ThemeSync theme={preferences.theme} />
      <AppShell
        sidebar={
          <AppSidebar
            activeOrganizationId={organizationSession.activeOrganizationId}
            organizations={organizationSession.organizations}
            scope={{
              hasAppDestination: organizationSession.organizations.length > 0,
              kind: "settings",
            }}
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
