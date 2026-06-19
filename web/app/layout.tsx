import type { Metadata } from "next"
import { Archivo } from "next/font/google"
import "./globals.css"
import { cn } from "@/lib/utils"
import Providers from "./providers"

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" })

export const metadata: Metadata = {
  title: {
    default: "ClawArmor - AccuKnox",
    template: "%s | ClawArmor - AccuKnox",
  },
  description: "Infra for your AI agents",
  icons: ["/favicon.svg"],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", "font-sans", "font-heading", archivo.variable)}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-svh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
