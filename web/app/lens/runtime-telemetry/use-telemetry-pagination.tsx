"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

export function useTelemetryPagination() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const stack = parseTokenStack(searchParams.get("telemetry_token_stack"))
  const currentPageToken = searchParams.get("telemetry_page_token")
  const canGoPrevious = stack.length > 0 || currentPageToken !== null

  function replace(values: { pageToken?: string; tokenStack?: string[] }) {
    const params = new URLSearchParams(searchParams)
    if (values.pageToken) {
      params.set("telemetry_page_token", values.pageToken)
    } else {
      params.delete("telemetry_page_token")
    }

    if (values.tokenStack && values.tokenStack.length > 0) {
      params.set("telemetry_token_stack", values.tokenStack.join(","))
    } else {
      params.delete("telemetry_token_stack")
    }

    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`)
    })
  }

  return {
    pending,
    canGoPrevious,
    goPrevious() {
      const nextStack = stack.slice(0, -1)
      replace({ pageToken: stack.at(-1), tokenStack: nextStack })
    },
    goNext(nextPageToken: string) {
      replace({
        pageToken: nextPageToken,
        tokenStack: currentPageToken ? [...stack, currentPageToken] : stack,
      })
    },
  }
}

function parseTokenStack(value: string | null) {
  if (!value) {
    return []
  }

  return value.split(",").filter(Boolean)
}
