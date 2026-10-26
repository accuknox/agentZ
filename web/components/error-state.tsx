"use client"

import Image from "next/image"
import Link from "next/link"
import type { Route } from "next"
import { usePathname, useRouter } from "next/navigation"
import { useEffect } from "react"
import { routeFallback } from "@/lib/page-selection"
import { ArrowLeft, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

type ErrorKind = "forbidden" | "network" | "not-found" | "timeout" | "unreadable" | "unknown"

type ErrorContent = {
  image: "/cry-emoji.svg" | "/file-corrupted.svg"
  title: string
}

const errorContent: Record<ErrorKind, ErrorContent> = {
  forbidden: {
    image: "/cry-emoji.svg",
    title: "Access denied",
  },
  network: {
    image: "/cry-emoji.svg",
    title: "Service unavailable",
  },
  "not-found": {
    image: "/file-corrupted.svg",
    title: "Page not found",
  },
  timeout: {
    image: "/cry-emoji.svg",
    title: "Request timed out",
  },
  unreadable: {
    image: "/file-corrupted.svg",
    title: "Data could not be read",
  },
  unknown: {
    image: "/cry-emoji.svg",
    title: "Page could not load",
  },
}

export function ErrorState({
  description,
  error,
  kind,
  onRetry,
}: {
  description?: string
  error?: Error & { digest?: string }
  kind?: ErrorKind
  onRetry?: () => void
}) {
  useEffect(() => {
    if (error) {
      console.error(error)
    }
  }, [error])

  const content = errorContent[kind ?? "unknown"]

  return (
    <Empty className="min-h-80 gap-5 rounded-none border-0 py-10" role="alert">
      <EmptyHeader className="gap-3">
        <EmptyMedia className="mb-1">
          <Image alt="" height={112} src={content.image} width={112} priority />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">
          <h1>{content.title}</h1>
        </EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
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
  unstable_retry: () => void
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

export function PageError({ error, unstable_retry }: RouteErrorProps) {
  return (
    <main className="flex w-full min-w-0 flex-1 items-center justify-center p-4 md:p-6">
      <ErrorState error={error} onRetry={unstable_retry} />
    </main>
  )
}

export function NestedPageError({ error, unstable_retry }: RouteErrorProps) {
  return (
    <div className="flex w-full min-w-0 flex-1 items-center justify-center p-4 md:p-6">
      <ErrorState error={error} onRetry={unstable_retry} />
    </div>
  )
}
