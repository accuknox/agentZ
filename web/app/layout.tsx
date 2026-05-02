import type { Metadata } from "next"
import { Suspense } from "react"
import { Oxanium, Roboto } from "next/font/google"
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
import { listAgentsAction } from "@/data/agent.actions"
import Providers from "./providers"

const oxanium = Oxanium({ subsets: ["latin"], variable: "--font-heading" })

const roboto = Roboto({ subsets: ["latin"], variable: "--font-roboto" })

export const metadata: Metadata = {
  title: "Clawarmor",
  description: "The AI that actually does things - SECURELY.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", "font-sans", roboto.variable, oxanium.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              <div className="flex items-center gap-2 px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                />
                <Suspense fallback={<BreadcrumbFallback />}>
                  <PageBreadcrumb agents={listAgentsAction()} />
                </Suspense>
              </div>
            </header>
            {children}
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
