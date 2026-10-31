"use client"

import "@/lib/gateway/client-interceptors"
import { getQueryClient } from "@/lib/utils"
import { QueryClientProvider } from "@tanstack/react-query"
import { ProgressProvider } from "@bprogress/next/app"
import { ThemeProvider } from "next-themes"
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { authClient } from "@/lib/auth-client"
import { chatCache } from "@/components/blocks/chat/cache"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { ScopeTransitionProvider } from "@/components/scope-transition"
import { useRouter } from "next/navigation"

const sidebarStyle: CSSProperties & { "--sidebar-width": string } = {
  "--sidebar-width": "20rem",
}

export default function Providers({
  children,
  sidebarDefaultOpen,
}: {
  children: ReactNode
  sidebarDefaultOpen: boolean
}) {
  const queryClient = getQueryClient()
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const previousUser = useRef<string | null | undefined>(undefined)
  const userID = session?.user.id ?? null
  useEffect(() => {
    if (isPending) return
    const previous = previousUser.current
    previousUser.current = userID
    if (previous === undefined || previous === userID) return
    // Better Auth broadcasts identity changes to other tabs too. Userless
    // query keys and delayed disk writes must not survive that boundary.
    void queryClient.cancelQueries().then(() => {
      queryClient.clear()
      void chatCache.clear()
      router.refresh()
    })
  }, [isPending, queryClient, router, userID])
  return (
    <QueryClientProvider client={queryClient}>
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
          <ScopeTransitionProvider>
            <TooltipProvider delayDuration={450}>
              <SidebarProvider defaultOpen={sidebarDefaultOpen} style={sidebarStyle}>
                {children}
              </SidebarProvider>
            </TooltipProvider>
          </ScopeTransitionProvider>
          <Toaster />
        </ThemeProvider>
      </ProgressProvider>
    </QueryClientProvider>
  )
}
