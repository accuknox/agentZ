"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

const numberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function formatCompactNumber(value: number) {
  return numberFormatter.format(value)
}

export function shortLensID(value: string) {
  return value.slice(0, 8)
}

export function percentOf(value: number, total: number) {
  if (total <= 0) {
    return 0
  }

  return (value / total) * 100
}

export function useTokenPagination() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const stack = parseTokenStack(searchParams.get("token_stack"))
  const currentPageToken = searchParams.get("page_token")
  const canGoPrevious = stack.length > 0 || currentPageToken !== null

  function replace(values: { pageToken?: string; tokenStack?: string[] }) {
    const params = new URLSearchParams(searchParams)
    if (values.pageToken) {
      params.set("page_token", values.pageToken)
    } else {
      params.delete("page_token")
    }

    if (values.tokenStack && values.tokenStack.length > 0) {
      params.set("token_stack", values.tokenStack.join(","))
    } else {
      params.delete("token_stack")
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
