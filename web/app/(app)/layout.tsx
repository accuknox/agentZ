import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { AppSidebar } from "@/components/blocks/sidebar/sidebar"
import { PageBreadcrumb } from "@/components/blocks/breadcrumbs/page-breadcrumb"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { getAuth } from "@/lib/auth"
import { ensureTenant } from "@/lib/gateway/client/sdk.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AppLayoutFallback />}>
      <AppGate>{children}</AppGate>
    </Suspense>
  )
}

async function AppGate({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })

  if (!session) {
    redirect("/signin")
  }

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

  return (
    <>
      <Suspense fallback={null}>
        <AppSidebar
          user={{
            email: session.user.email,
            image: session.user.image,
            name: session.user.name,
          }}
        />
      </Suspense>
      <SidebarInset>
        <header className="flex h-16 min-w-0 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex min-w-0 items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <PageBreadcrumb />
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {children}
        </div>
      </SidebarInset>
    </>
  )
}

function AppLayoutFallback() {
  return (
    <SidebarInset>
      <header className="flex h-16 min-w-0 shrink-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Home</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" />
    </SidebarInset>
  )
}
