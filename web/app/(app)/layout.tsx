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
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { auth } from "@/lib/auth"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <AppGate>{children}</AppGate>
    </Suspense>
  )
}

async function AppGate({ children }: { children: React.ReactNode }) {
  "use cache: private"

  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    redirect("/login")
  }

  return (
    <>
      <Suspense fallback={null}>
        <AppSidebar
          user={{
            image: session.user.image,
            name: session.user.name,
          }}
        />
      </Suspense>
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <Suspense fallback={<BreadcrumbFallback />}>
              <PageBreadcrumbWrapper />
            </Suspense>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {children}
        </div>
      </SidebarInset>
    </>
  )
}

async function PageBreadcrumbWrapper() {
  const agents = listAgentsCachedQuery()
  return <PageBreadcrumb agents={agents} />
}

function BreadcrumbFallback() {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage>Home</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
