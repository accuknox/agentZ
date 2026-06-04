import type { Metadata } from "next"
import { Suspense } from "react"
import { Archivo } from "next/font/google"
import "./globals.css"
import { cn } from "@/lib/utils"
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
import Providers from "./providers"

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" })

export const metadata: Metadata = {
  title: "Clawarmor",
  description: "The AI that actually does things - SECURELY.",
  icons: ["/favicon.svg"],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const agents = listAgentsCachedQuery()

  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", "font-sans", "font-heading", archivo.variable)}
      suppressHydrationWarning
    >
      <body className="flex h-svh flex-col overflow-hidden">
        <Providers>
          <AppSidebar agents={agents} />
          <SidebarInset>
            <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              <div className="flex items-center gap-2 px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                />
                <Suspense fallback={<BreadcrumbFallback />}>
                  <PageBreadcrumb agents={agents} />
                </Suspense>
              </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
              {children}
            </div>
          </SidebarInset>
        </Providers>
      </body>
    </html>
  )
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
