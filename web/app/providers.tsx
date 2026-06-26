"use client"

import "@/lib/gateway/client-interceptors"
import { getQueryClient } from "@/lib/utils"
import { QueryClientProvider } from "@tanstack/react-query"
import { ProgressProvider } from "@bprogress/next/app"
import { ThemeProvider } from "next-themes"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarProvider } from "@/components/ui/sidebar"

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
          <TooltipProvider>
            <SidebarProvider>{children}</SidebarProvider>
          </TooltipProvider>
        </ThemeProvider>
      </ProgressProvider>
    </QueryClientProvider>
  )
}
