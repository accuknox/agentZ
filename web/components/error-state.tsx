"use client"

import Image from "next/image"
import { useEffect } from "react"
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
  description: string
  image: "/cry-emoji.svg" | "/file-corrupted.svg"
  title: string
}

const errorContent: Record<ErrorKind, ErrorContent> = {
  forbidden: {
    description: "Your account does not have access to this page.",
    image: "/cry-emoji.svg",
    title: "Access denied",
  },
  network: {
    description: "The service could not be reached. Check your connection and try again.",
    image: "/cry-emoji.svg",
    title: "Service unavailable",
  },
  "not-found": {
    description: "The page may have moved, been deleted, or never existed.",
    image: "/file-corrupted.svg",
    title: "Page not found",
  },
  timeout: {
    description: "The service took too long to respond. Trying again usually resolves this.",
    image: "/cry-emoji.svg",
    title: "Request timed out",
  },
  unreadable: {
    description: "The returned data could not be read. Try loading a fresh copy.",
    image: "/file-corrupted.svg",
    title: "Data could not be read",
  },
  unknown: {
    description: "An unexpected problem prevented this page from loading.",
    image: "/cry-emoji.svg",
    title: "Page could not load",
  },
}

function errorKind(value?: string): ErrorKind {
  const message = value?.toLocaleLowerCase() ?? ""

  if (/\b(401|403|forbidden|permission|unauthori[sz]ed|access denied)\b/.test(message)) {
    return "forbidden"
  }
  if (/\b(404|not found|does not exist)\b/.test(message)) {
    return "not-found"
  }
  if (/\b(timeout|timed out|deadline exceeded)\b/.test(message)) {
    return "timeout"
  }
  if (/\b(parse|invalid json|corrupt|malformed|decode)\b/.test(message)) {
    return "unreadable"
  }
  if (/\b(network|fetch|connection|offline|unavailable|gateway)\b/.test(message)) {
    return "network"
  }
  return "unknown"
}

export function ErrorState({
  error,
  kind,
  message,
  onRetry,
}: {
  error?: Error & { digest?: string }
  kind?: ErrorKind
  message?: string
  onRetry?: () => void
}) {
  useEffect(() => {
    if (error) {
      console.error(error)
    }
  }, [error])

  const content = errorContent[kind ?? errorKind(message ?? error?.message)]

  return (
    <Empty className="min-h-80 gap-5 rounded-none border-0 py-10" role="alert">
      <EmptyHeader className="gap-3">
        <EmptyMedia className="mb-1">
          <Image alt="" height={112} src={content.image} width={112} priority />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">
          <h1>{content.title}</h1>
        </EmptyTitle>
        <EmptyDescription>{content.description}</EmptyDescription>
        {error?.digest ? (
          <p className="text-muted-foreground font-mono text-xs">Reference: {error.digest}</p>
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
