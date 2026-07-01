import type { Metadata } from "next"
import { Archivo } from "next/font/google"
import "./globals.css"
import Providers from "./providers"

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" })

export const metadata: Metadata = {
  title: {
    default: "AgentZ - AccuKnox",
    template: "%s | AgentZ - AccuKnox",
  },
  description: "Control-plane for your AI agents",
  icons: ["/favicon.svg"],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`font-heading h-full font-sans antialiased ${archivo.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-svh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
