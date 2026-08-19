import type { ReactNode } from "react"
import { FileWorkspaceProvider } from "@/components/blocks/chat/file-workspace-store"
import { SidebarInset } from "@/components/ui/sidebar"

export function AppShell({ children, sidebar }: { children: ReactNode; sidebar: ReactNode }) {
  return (
    <FileWorkspaceProvider>
      {sidebar}
      <SidebarInset className="h-svh max-h-svh" id="main-content">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          {children}
        </div>
      </SidebarInset>
    </FileWorkspaceProvider>
  )
}
