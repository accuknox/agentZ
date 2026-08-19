import type { ReactNode } from "react"
import { FileWorkspaceProvider } from "@/components/blocks/chat/file-workspace-store"
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"

export function AppShell({ children, sidebar }: { children: ReactNode; sidebar: ReactNode }) {
  return (
    <FileWorkspaceProvider>
      {sidebar}
      <SidebarInset className="h-svh max-h-svh" id="main-content">
        <header className="flex h-14 min-w-0 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex min-w-0 flex-1 items-center px-3">
            <SidebarTrigger className="-ml-1" />
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {children}
        </div>
      </SidebarInset>
    </FileWorkspaceProvider>
  )
}
