import type { Metadata } from "next"
import { Archivo } from "next/font/google"
import "./globals.css"
import Providers from "./providers"

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" })

export const metadata: Metadata = {
  title: {
    default: "AgentZ | AccuKnox AgentZ",
    template: "%s | AccuKnox AgentZ",
  },
  description: "Control-plane for your AI agents",
  icons: ["/favicon.svg"],
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
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
