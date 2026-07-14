"use client"

import "@/lib/gateway/client-interceptors"
import { getQueryClient } from "@/lib/utils"
import { QueryClientProvider } from "@tanstack/react-query"
import { ProgressProvider } from "@bprogress/next/app"
import { ThemeProvider } from "next-themes"
import type { CSSProperties, ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"

const sidebarStyle: CSSProperties & { "--sidebar-width": string } = {
  "--sidebar-width": "17.5rem",
}

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={getQueryClient()}>
      <ProgressProvider
        height="2px"
        color="var(--primary)"
        options={{ showSpinner: false }}
        shallowRouting
        delay={100}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={450}>
            <SidebarProvider style={sidebarStyle}>{children}</SidebarProvider>
          </TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </ProgressProvider>
    </QueryClientProvider>
  )
}
