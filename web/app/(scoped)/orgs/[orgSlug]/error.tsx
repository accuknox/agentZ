"use client"

import { ErrorState } from "@/components/error-state"

export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
      <ErrorState error={error} onRetry={unstable_retry} />
    </div>
  )
}
