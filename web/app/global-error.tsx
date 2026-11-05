"use client"

import { ErrorState } from "@/components/error-state"
import "./globals.css"

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <html lang="en">
      <head>
        <title>Application error | AgentZ</title>
      </head>
      <body>
        <main className="flex min-h-svh items-center justify-center p-6">
          <ErrorState error={error} onRetry={retry} />
        </main>
      </body>
    </html>
  )
}
