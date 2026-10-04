import type { Metadata } from "next"
import { Archivo } from "next/font/google"
import { cookies } from "next/headers"
import { connection } from "next/server"
import { Suspense } from "react"
import { AgentZTransition } from "@/components/scope-transition"
import { getEnv } from "@/lib/env"
import "./globals.css"
import Providers from "./providers"

const archivo = Archivo({
  axes: ["wdth"],
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-archivo",
})
const socialTitle = "AgentZ | By Team AccuKnox"
const description =
  "Zero-trust agentic AI platform. Build, run, and govern AI agents. Secure by design."
const socialImage = {
  url: "/agentz-social-card.png",
  alt: "AgentZ by Team AccuKnox",
  width: 1200,
  height: 630,
}

export async function generateMetadata(): Promise<Metadata> {
  // The public origin is deployment-specific and must stay out of the image.
  await connection()

  return {
    metadataBase: new URL(getEnv().BETTER_AUTH_URL),
    title: {
      default: "AgentZ",
      template: "%s | AgentZ",
    },
    description,
    icons: ["/agentz-logo.svg"],
    openGraph: {
      title: socialTitle,
      description,
      images: [socialImage],
      siteName: "AgentZ",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [socialImage],
    },
  }
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`h-full font-sans font-medium antialiased ${archivo.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-svh bg-background text-foreground">
        <a
          className="fixed top-2 left-2 z-50 -translate-y-16 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition-transform focus-visible:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring"
          href="#main-content"
        >
          Skip to content
        </a>
        <Suspense fallback={<AgentZTransition />}>
          <RequestProviders>{children}</RequestProviders>
        </Suspense>
      </body>
    </html>
  )
}

async function RequestProviders({ children }: { children: React.ReactNode }) {
  const store = await cookies()

  return (
    <Providers sidebarDefaultOpen={store.get("sidebar_state")?.value !== "false"}>
      <Suspense fallback={<AgentZTransition />}>{children}</Suspense>
    </Providers>
  )
}
