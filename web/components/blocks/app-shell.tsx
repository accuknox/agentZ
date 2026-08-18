import type { ReactNode } from "react"
import { PageBreadcrumb } from "@/components/blocks/breadcrumbs/page-breadcrumb"
import { FileWorkspaceProvider } from "@/components/blocks/chat/file-workspace-store"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"

export function AppShell({
  breadcrumbLabels,
  children,
  sidebar,
}: {
  breadcrumbLabels?: Readonly<Record<number, string>>
  children: ReactNode
  sidebar: ReactNode
}) {
  return (
    <FileWorkspaceProvider>
      {sidebar}
      <SidebarInset className="h-svh max-h-svh" id="main-content">
        <header className="flex h-14 min-w-0 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <PageBreadcrumb labels={breadcrumbLabels} />
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto has-[[data-chat-page]]:overflow-y-hidden">
          {children}
        </div>
      </SidebarInset>
    </FileWorkspaceProvider>
  )
}

export function AppShellFallback() {
  return (
    <SidebarInset className="h-svh max-h-svh" id="main-content">
      <header className="flex h-14 min-w-0 shrink-0 items-center gap-2 border-b">
        <div className="flex min-w-0 items-center gap-2 px-3">
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
