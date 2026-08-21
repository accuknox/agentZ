import type { Metadata } from "next"
import { Archivo } from "next/font/google"
import { connection } from "next/server"
import { Suspense } from "react"
import { AgentZTransition } from "@/components/scope-transition"
import { getEnv } from "@/lib/env"
import "./globals.css"
import Providers from "./providers"

const archivo = Archivo({
  axes: ["wdth"],
  subsets: ["latin"],
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
      className={`h-full font-sans antialiased ${archivo.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-svh">
        <a
          className="bg-background text-foreground focus-visible:ring-ring fixed top-2 left-2 z-50 -translate-y-16 rounded-md px-3 py-2 text-sm font-medium shadow-sm transition-transform focus-visible:translate-y-0 focus-visible:ring-2"
          href="#main-content"
        >
          Skip to content
        </a>
        <Providers>
          <Suspense fallback={<AgentZTransition />}>{children}</Suspense>
        </Providers>
      </body>
    </html>
  )
}
