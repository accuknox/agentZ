"use client"

import Link from "next/link"
import type { Route } from "next"
import { usePathname, useRouter } from "next/navigation"
import { useEffect } from "react"
import { routeFallback } from "@/lib/page-selection"
import { ArrowLeft, CloudOff, FileQuestionMark, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { StateIllustration } from "@/components/state-illustration"

export function ErrorState({
  error,
  kind,
  onRetry,
}: {
  error?: Error & { digest?: string }
  kind?: "not-found"
  onRetry?: () => void
}) {
  useEffect(() => {
    if (error) {
      console.error(error)
    }
  }, [error])

  const missing = kind === "not-found"

  return (
    <Empty className="min-h-80 gap-5 rounded-none border-0 py-10" role="alert">
      <EmptyHeader className="gap-3">
        <EmptyMedia className="mb-1">
          <StateIllustration
            icon={missing ? FileQuestionMark : CloudOff}
            badge={missing ? "?" : "!"}
          />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">
          <h1>{missing ? "Page not found" : "Page could not load"}</h1>
        </EmptyTitle>
        {error?.digest ? (
          <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
        ) : null}
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {onRetry ? (
          <Button onClick={onRetry} type="button">
            <RefreshCw data-icon="inline-start" />
            Try again
          </Button>
        ) : null}
        <Button onClick={() => window.history.back()} type="button" variant="outline">
          <ArrowLeft data-icon="inline-start" />
          Go back
        </Button>
      </EmptyContent>
    </Empty>
  )
}

type RouteErrorProps = {
  error: Error & { digest?: string }
  retry: () => void
}

/** Unknown saved paths recover only when this boundary actually mounts. */
export function MissingPage() {
  const pathname = usePathname()
  const router = useRouter()
  const fallback = routeFallback(pathname)
  useEffect(() => {
    if (new URLSearchParams(location.search).has("__restore")) {
      router.replace(`${fallback}?__recovered=1` as Route)
    }
  }, [fallback, router])
  return (
    <main className="flex min-h-80 w-full flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <ErrorState kind="not-found" />
        <div className="flex justify-center">
          <Button asChild>
            <Link href={fallback}>Return to available pages</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}

export function PageError({ error, retry }: RouteErrorProps) {
  return (
    <main className="flex w-full min-w-0 flex-1 items-center justify-center p-4 md:p-6">
      <ErrorState error={error} onRetry={retry} />
    </main>
  )
}

export function NestedPageError({ error, retry }: RouteErrorProps) {
  return (
    <div className="flex w-full min-w-0 flex-1 items-center justify-center p-4 md:p-6">
      <ErrorState error={error} onRetry={retry} />
    </div>
  )
}
