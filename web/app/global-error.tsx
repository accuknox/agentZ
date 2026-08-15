"use client"

import { ErrorState } from "@/components/error-state"
import "./globals.css"

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return (
    <html lang="en">
      <head>
        <title>Application error | AccuKnox AgentZ</title>
      </head>
      <body>
        <main className="flex min-h-svh items-center justify-center p-6">
          <ErrorState error={error} onRetry={unstable_retry} />
        </main>
      </body>
    </html>
  )
}
